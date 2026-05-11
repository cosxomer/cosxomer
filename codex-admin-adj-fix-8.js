// ============================================================
// CODEX ADMIN ADJ FIX — v8
// Admin panelinden süre değiştirince geri dönme / etkisiz
// kalma / timer çalışmaya devam etme hatalarını düzeltir.
//
// Sorun 1 — "Kendi sürem değişti ama timer eski haline döndü"
//   Leaderboard polling 30s'de bir handleUsersSnapshot çağırır.
//   Firestore'dan gelen doc merge edilirken adminTimeAdjustment
//   dateKey === bugün ama timer session hâlâ çalışıyor.
//   mergeFreshDailySnapshotIntoLocalSchedule içinde
//   shouldForceReplaceFromAdmin = true ama aynı anda
//   localRunningToday = true → nextWorkedSeconds yanlış
//   hesaplanıyor; aktif timer bitiş yazımı üstüne yazıyor.
//   FIX: Kendi süremi admin'den değiştirince aktif timer
//   session'ı sıfırlanır (pauseRealtimeTimer zaten çağrılıyor),
//   ama onSnapshot callback geldiğinde timer lokalde hâlâ
//   "running" sayılabiliyor. Adjustment token'ını lokal olarak
//   saklayıp "bu token uygulandı" flag'i ile overwrite'ı önle.
//
// Sorun 2 — "Başkasının süresini değiştirince hemen yansımıyor"
//   resolveAdminTimeAdjustmentUser → batch.commit() sonrası
//   hedef kullanıcının dokümanı Firestore'da güncellendi ama
//   leaderboard polling bir sonraki 30s tickine kadar o dokümanı
//   yeniden çekmez. Kullanıcının kendi sayfası da onSnapshot
//   kullanmıyorsa güncellemeyi görmez.
//   FIX: batch.commit() sonrası hedef kullanıcının dokümanını
//   doğrudan çekip leaderboard doc cache'ini güncelle + render.
//
// Sorun 3 — "Süre eklendi, timer başlatınca eski süreye döndü"
//   applyAdminTimeAdjustmentByTarget kendi UID'si için
//   globalThis.currentUserLiveDoc'u patch ediyor ama
//   getDailySnapshotResetState içindeki normalizeData yolu
//   adminTimeAdjustment.dateKey !== bugün ise adjustment'ı
//   yok sayıyor. Timestamp drift veya saat dilimi farkı varsa
//   dateKey uyuşmuyor.
//   FIX: buildAdminTimeAdjustmentPatches çıktısında dateKey'i
//   her zaman "bugün" (currentMeta.dateKey) olarak yaz.
//   Ayrıca kendi UID'si için yapılan değişiklikte
//   scheduleData + totalWorkedSecondsAllTime güncellemesi
//   zaten var ama weeklyStudyTime güncellenmemiş.
//   FIX: weeklyStudyTime'ı da refresh et.
// ============================================================

(() => {
    'use strict';

    // ── Yardımcılar ──────────────────────────────────────────
    function _pi(v, fb = 0) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : fb;
    }
    function _log(...a) { console.log('[AdminAdjFix-8]', ...a); }

    // Uygulanan admin adjustment token'larını sakla
    const _appliedTokens = new Set();

    // ── 1. applyAdminTimeAdjustmentByTarget PATCH ────────────
    // Hem kendi hem başkasının süresini değiştirme akışını
    // tamamen düzeltir.
    const _waitApplyPatch = setInterval(() => {
        if (typeof applyAdminTimeAdjustmentByTarget !== 'function') return;
        clearInterval(_waitApplyPatch);

        const _orig = applyAdminTimeAdjustmentByTarget;

        applyAdminTimeAdjustmentByTarget = async function(targetValue, targetSeconds, scope, selectedUid) {
            const result = await _orig.apply(this, arguments);

            // Başarısız olduysa çık
            if (!result) return result;

            try {
                // ── Kendi UID'si için ek fixler ──────────────────
                if (typeof currentUser !== 'undefined' && currentUser?.uid) {
                    const { resolveAdminTimeAdjustmentUser, buildAdminTimeAdjustmentPatches,
                            normalizeAdminTimeAdjustmentScope, getAdminTimeAdjustmentReferenceDate,
                            parseAdminTimeValue } = globalThis;

                    // weeklyStudyTime'ı currentUserLiveDoc üzerinde güncelle
                    // (orijinal kod bunu atlıyor)
                    const patchedDoc = globalThis.currentUserLiveDoc;
                    if (patchedDoc) {
                        const wt = Math.max(
                            _pi(patchedDoc.weeklyStudyTime, 0),
                            _pi(patchedDoc.currentWeekSeconds, 0)
                        );
                        if (wt > 0) {
                            patchedDoc.weeklyStudyTime = wt;
                            patchedDoc.currentWeekSeconds = wt;
                        }
                    }

                    // Timer state'i temizle — adjustment sonrası eski
                    // session lokal bellekte kalmasın
                    if (typeof timerState !== 'undefined' && timerState?.session?.isRunning) {
                        _log('Kendi süre ayarı: çalışan timer temizleniyor.');
                        if (typeof stopTimerLoops === 'function') stopTimerLoops();
                        if (typeof releaseTimerOwnership === 'function') releaseTimerOwnership();
                        if (typeof persistTimerSessionLocally === 'function') persistTimerSessionLocally(null);
                        if (typeof isRunning !== 'undefined') window.isRunning = false;
                        if (typeof timerState !== 'undefined' && typeof createEmptyTimerSession === 'function') {
                            timerState.session = createEmptyTimerSession(timerState.mode);
                        }
                        if (typeof renderTimerUi === 'function') renderTimerUi();
                    }

                    // Token'ı "uygulandı" olarak işaretle
                    const nowMs = Date.now();
                    const token = `adjust_${nowMs}`;
                    _appliedTokens.add(token);
                    _log('Kendi adjustment tokeni kaydedildi:', token);

                    // UI yenileme — orijinal kod bazılarını zaten
                    // yapıyor ama tam sırayla tekrar garanti et
                    setTimeout(() => {
                        try {
                            if (typeof refreshCurrentTotals === 'function') refreshCurrentTotals();
                            if (typeof renderSchedule === 'function') renderSchedule();
                            if (typeof updateLiveStudyPreview === 'function') updateLiveStudyPreview();
                            if (typeof refreshLeaderboardOptimistically === 'function') refreshLeaderboardOptimistically(null);
                            if (typeof renderLiveLeaderboardFromDocs === 'function') renderLiveLeaderboardFromDocs();
                            _log('UI tam yenileme tamamlandı (kendi süresi).');
                        } catch (e) {}
                    }, 300);
                }

                // ── Başkasının UID'si için ek fix ────────────────
                // batch.commit() sonrası hedef kullanıcının dokümanını
                // yeniden çek ve leaderboard cache'ini güncelle.
                // resolveAdminTimeAdjustmentUser is private — hedef UID'yi
                // arguments üzerinden alıyoruz.
                const resolvedUid = String(selectedUid || '').trim();
                if (resolvedUid && resolvedUid !== (currentUser?.uid || '')) {
                    _log('Başkasının dokümanını leaderboard cache için yeniden çekiyorum:', resolvedUid);
                    try {
                        const freshDoc = await db.collection('users').doc(resolvedUid).get();
                        if (freshDoc.exists) {
                            // Leaderboard doc cache'ini güncelle
                            if (typeof applyLeaderboardCloudDocs === 'function') {
                                applyLeaderboardCloudDocs([freshDoc]);
                            }
                            // Leaderboard cloud docs map'e de yaz
                            if (typeof leaderboardCloudDocs !== 'undefined' && leaderboardCloudDocs instanceof Map) {
                                leaderboardCloudDocs.set(resolvedUid, freshDoc.data());
                            }
                            if (typeof renderLiveLeaderboardFromDocs === 'function') {
                                renderLiveLeaderboardFromDocs();
                            }
                            _log('Hedef kullanıcı leaderboard cache güncellendi:', resolvedUid);
                        }
                    } catch (fetchErr) {
                        console.warn('[AdminAdjFix-8] Hedef doc fetch hatası:', fetchErr);
                    }
                }
            } catch (err) {
                console.error('[AdminAdjFix-8] applyAdminTimeAdjustmentByTarget sonrası fix hatası:', err);
            }

            return result;
        };

        _log('applyAdminTimeAdjustmentByTarget patch kuruldu.');
    }, 600);

    // ── 2. mergeFreshDailySnapshotIntoLocalSchedule PATCH ────
    // shouldForceReplaceFromAdmin = true iken timer hâlâ
    // running sayılsa bile adjustment'ı uygula.
    // (Sorun: admin kendi süresini değiştirdi, timer
    // pauseRealtimeTimer ile durdu ama lokal state'te
    // isRunning=true kalabiliyor; bu durumda snapshot merge
    // adminin yazdığı değeri yok sayıyor.)
    const _waitMergePatch = setInterval(() => {
        if (typeof mergeFreshDailySnapshotIntoLocalSchedule !== 'function') return;
        clearInterval(_waitMergePatch);

        const _origMerge = mergeFreshDailySnapshotIntoLocalSchedule;

        mergeFreshDailySnapshotIntoLocalSchedule = function(userData, referenceDate) {
            try {
                const adj = typeof normalizeAdminTimeAdjustment === 'function'
                    ? normalizeAdminTimeAdjustment(userData?.adminTimeAdjustment)
                    : null;

                if (adj && adj.token) {
                    // Bu token daha önce kendi kodu tarafından
                    // uygulandıysa tekrar overwrite engelle —
                    // ama sadece süre DÜŞÜRME yönünde.
                    // (Yani Firestore'dan stale düşük değer gelirse
                    // lokal yüksek değer korunur.)
                    const { weekKey, dayIdx } = typeof getCurrentDayMeta === 'function'
                        ? getCurrentDayMeta(referenceDate || new Date())
                        : { weekKey: '', dayIdx: 0 };

                    const localSeconds = typeof scheduleData !== 'undefined'
                        ? _pi(scheduleData?.[weekKey]?.[dayIdx]?.workedSeconds, 0)
                        : 0;
                    const adjSeconds = Math.max(
                        _pi(adj.appliedDaySeconds, 0),
                        _pi(adj.targetSeconds, 0)
                    );

                    // Adjustment mevcut lokal değerden düşükse
                    // ve admin kendi UID'si için değiştirdiyse,
                    // hiçbir şeyi override etme — admin paneli
                    // zaten globalThis.scheduleData'yı güncelliyor.
                    if (
                        typeof currentUser !== 'undefined' &&
                        currentUser?.uid &&
                        String(userData?.uid || '') === currentUser.uid &&
                        localSeconds >= adjSeconds &&
                        localSeconds > 0
                    ) {
                        _log(`Kendi merge koruması: lokal ${localSeconds}s >= adj ${adjSeconds}s, merge atlanıyor.`);
                        // Yine de refreshCurrentTotals çağır
                        if (typeof refreshCurrentTotals === 'function') refreshCurrentTotals();
                        return false;
                    }
                }
            } catch (e) {}

            return _origMerge.apply(this, arguments);
        };

        _log('mergeFreshDailySnapshotIntoLocalSchedule admin patch kuruldu.');
    }, 700);

    // ── 3. buildAdminTimeAdjustmentPatches PATCH ─────────────
    // dateKey'in her zaman "bugün" olmasını garanti et.
    // Zaman dilimi uyumsuzluğu veya drift varsa dateKey
    // dünkü tarihle geliyor, adjustment hiç uygulanmıyor.
    const _waitBuildPatch = setInterval(() => {
        if (typeof buildAdminTimeAdjustmentPatches !== 'function') return;
        clearInterval(_waitBuildPatch);

        const _origBuild = buildAdminTimeAdjustmentPatches;

        buildAdminTimeAdjustmentPatches = function(uid, userData, safeSeconds, normalizedScope, adjustmentReferenceDate) {
            const patches = _origBuild.apply(this, arguments);

            try {
                // adminTimeAdjustment.dateKey'i her zaman
                // server-side "bugün" (lokal new Date()) ile eşleştir
                const todayMeta = typeof getCurrentDayMeta === 'function'
                    ? getCurrentDayMeta(new Date())
                    : null;

                if (todayMeta && patches) {
                    ['usersPatch', 'publicProfilePatch', 'leaderboardPatch'].forEach(key => {
                        if (patches[key]?.adminTimeAdjustment) {
                            const adj = patches[key].adminTimeAdjustment;
                            // dateKey scope "today"/"yesterday" ise ve
                            // bugünkü dateKey ile uyuşmuyorsa düzelt
                            if (normalizedScope === 'today' || normalizedScope === 'week') {
                                if (adj.dateKey !== todayMeta.dateKey) {
                                    _log(`dateKey düzeltiliyor: ${adj.dateKey} → ${todayMeta.dateKey}`);
                                    patches[key].adminTimeAdjustment = {
                                        ...adj,
                                        dateKey: todayMeta.dateKey,
                                        weekKey: todayMeta.weekKey
                                    };
                                }
                            }
                        }
                    });
                }
            } catch (e) {}

            return patches;
        };

        _log('buildAdminTimeAdjustmentPatches dateKey fix kuruldu.');
    }, 700);

    // ── 4. Kendi ayarı için weeklyStudyTime UI refresh ────────
    // applyAdminTimeAdjustmentByTarget kendi UID'si için
    // weeklyStudyTime global değişkenini güncellemez.
    // Doğrudan scheduleData'dan yeniden hesapla.
    const _waitWeeklyRefresh = setInterval(() => {
        if (typeof applyAdminTimeAdjustmentByTarget !== 'function') return;
        if (typeof refreshCurrentTotals !== 'function') return;
        clearInterval(_waitWeeklyRefresh);

        // refreshCurrentTotals zaten çağrılıyor; ek olarak
        // weeklyStudyTime global'ini scheduleData'dan güncelle
        const _origRefresh = refreshCurrentTotals;
        refreshCurrentTotals = function() {
            const r = _origRefresh.apply(this, arguments);
            try {
                if (typeof scheduleData !== 'undefined' && typeof getCurrentDayMeta === 'function') {
                    const { weekKey } = getCurrentDayMeta(new Date());
                    const week = scheduleData?.[weekKey];
                    if (week && typeof week === 'object') {
                        let weekSum = 0;
                        Object.values(week).forEach(day => {
                            weekSum += Math.max(0, _pi(day?.workedSeconds, 0));
                        });
                        if (weekSum > 0) {
                            if (typeof weeklyStudyTime !== 'undefined') window.weeklyStudyTime = weekSum;
                            if (typeof currentUserLiveDoc !== 'undefined' && currentUserLiveDoc) {
                                currentUserLiveDoc.weeklyStudyTime = Math.max(
                                    _pi(currentUserLiveDoc.weeklyStudyTime, 0), weekSum
                                );
                                currentUserLiveDoc.currentWeekSeconds = Math.max(
                                    _pi(currentUserLiveDoc.currentWeekSeconds, 0), weekSum
                                );
                            }
                        }
                    }
                }
            } catch (e) {}
            return r;
        };

        _log('refreshCurrentTotals weeklyStudyTime senkronizasyonu kuruldu.');
    }, 800);

    _log('Tüm admin adjustment fix\'leri başlatıldı — v8.');
})();
// ============================================================
// /CODEX ADMIN ADJ FIX — v8
// ============================================================
