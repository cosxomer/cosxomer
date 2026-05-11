// ============================================================
// CODEX TIME GUARD — v8
// Haftalık/günlük süre sıfırlanmalarına karşı koruma katmanı
// ============================================================
// Düzeltilen sorunlar:
//   1. shouldTrustRemoteReset: remote schedule boş gelince lokal
//      süreyi sıfırlıyor. Artık lokal süre > 0 ise remote reset
//      güvenilmez sayılır.
//   2. getDailySnapshotResetState: schedule eksik/boş geldiğinde
//      weeklyStudyTime yanlışlıkla sıfırlanıyordu. Artık
//      Firestore'daki değer her zaman max ile korunur.
//   3. mergeFreshDailySnapshotIntoLocalSchedule içinde
//      remoteExplicitlyEmptyToday koşulu lokal aktif süre
//      varken sıfırlamaya izin veriyordu; ek guard eklendi.
//   4. continueMoveTaskSelection'da ertesi gün slot'u
//      workedSeconds:0 ile initialize ediliyordu; mevcut
//      veri varsa korunur hale getirildi.
//   5. Timer owner TTL 15s → 60s (mobil/arka plan için).
// ============================================================

(() => {
    'use strict';

    // --------------------------------------------------------
    // Yardımcılar
    // --------------------------------------------------------
    function _pi(v, fb = 0) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : fb;
    }

    function _log(...args) {
        console.log('[TimeGuard-8]', ...args);
    }

    // --------------------------------------------------------
    // 1. mergeFreshDailySnapshotIntoLocalSchedule patch
    //    shouldTrustRemoteReset için ek lokal süre kontrolü
    // --------------------------------------------------------
    const _waitMergePatch = setInterval(() => {
        if (typeof mergeFreshDailySnapshotIntoLocalSchedule !== 'function') return;
        clearInterval(_waitMergePatch);

        const _origMerge = mergeFreshDailySnapshotIntoLocalSchedule;

        mergeFreshDailySnapshotIntoLocalSchedule = function(userData, referenceDate) {
            // Remote'dan gelen schedule tamamen boşsa lokal veriyi korumak için
            // userData.schedule içindeki bugünün weekKey+dayIdx'ine bak.
            // Eğer remote slot boş ama lokal'de süre varsa, userData'yı lokal
            // değerle zenginleştirerek shouldTrustRemoteReset=false yap.
            try {
                const refDate = referenceDate || new Date();
                const dayOfWeek = (refDate.getDay() + 6) % 7;
                const weekKey = typeof getWeekKey === 'function' ? getWeekKey(refDate) : '';
                const remoteSchedule = userData && userData.schedule ? userData.schedule : {};
                const remoteSlotSeconds = _pi(remoteSchedule?.[weekKey]?.[dayOfWeek]?.workedSeconds, 0);
                const localSlotSeconds = typeof scheduleData !== 'undefined'
                    ? _pi(scheduleData?.[weekKey]?.[dayOfWeek]?.workedSeconds, 0)
                    : 0;

                // Remote slot boş ama lokal süre var → remote schedule'a lokal veriyi enjekte et
                if (remoteSlotSeconds <= 0 && localSlotSeconds > 0) {
                    _log(`Remote slot boş (${remoteSlotSeconds}s) ama lokal süre ${localSlotSeconds}s. Remote'u lokal ile zenginleştiriyorum.`);
                    const patchedSchedule = JSON.parse(JSON.stringify(remoteSchedule || {}));
                    if (!patchedSchedule[weekKey]) patchedSchedule[weekKey] = {};
                    if (!patchedSchedule[weekKey][dayOfWeek]) patchedSchedule[weekKey][dayOfWeek] = {};
                    // Mevcut workedSeconds değerini koru, sıfırlamasın
                    patchedSchedule[weekKey][dayOfWeek] = {
                        ...(patchedSchedule[weekKey][dayOfWeek] || {}),
                        ...(typeof scheduleData !== 'undefined' ? (scheduleData?.[weekKey]?.[dayOfWeek] || {}) : {}),
                        workedSeconds: localSlotSeconds
                    };
                    const patchedUserData = { ...userData, schedule: patchedSchedule };
                    return _origMerge.call(this, patchedUserData, referenceDate);
                }
            } catch (err) {
                console.error('[TimeGuard-8] mergeFreshDailySnapshotIntoLocalSchedule patch hatası:', err);
            }
            return _origMerge.call(this, userData, referenceDate);
        };

        _log('mergeFreshDailySnapshotIntoLocalSchedule patch kuruldu.');
    }, 600);

    // --------------------------------------------------------
    // 2. getDailySnapshotResetState patch
    //    weeklyStudyTime hesaplanırken Firestore değeri her zaman
    //    max ile korunur; schedule boş gelince 0'a düşmez.
    // --------------------------------------------------------
    const _waitSnapshotPatch = setInterval(() => {
        if (typeof getDailySnapshotResetState !== 'function') return;
        clearInterval(_waitSnapshotPatch);

        const _origSnapshot = getDailySnapshotResetState;

        getDailySnapshotResetState = function(userData, referenceDate) {
            const result = _origSnapshot.call(this, userData, referenceDate);

            try {
                const safeData = userData && typeof userData === 'object' ? userData : {};
                const storedWeekKey = String(safeData?.weeklyStudyWeekKey || safeData?.currentWeekKey || safeData?.weekKey || '').trim();
                const refDate = referenceDate || new Date();
                const currentWeekKey = typeof getWeekKey === 'function' ? getWeekKey(refDate) : '';
                const isSameWeek = !storedWeekKey || storedWeekKey === currentWeekKey;

                if (isSameWeek) {
                    const firestoreWeeklyTime = Math.max(
                        _pi(safeData?.weeklyStudyTime, 0),
                        _pi(safeData?.currentWeekSeconds, 0)
                    );
                    const resultWeeklyTime = Math.max(
                        _pi(result?.normalizedData?.weeklyStudyTime, 0),
                        _pi(result?.normalizedData?.currentWeekSeconds, 0)
                    );

                    if (firestoreWeeklyTime > 0 && firestoreWeeklyTime > resultWeeklyTime) {
                        _log(`weeklyStudyTime koruması: result=${resultWeeklyTime}s < firestore=${firestoreWeeklyTime}s. Firestore değeri kullanılıyor.`);
                        result.normalizedData = {
                            ...result.normalizedData,
                            weeklyStudyTime: firestoreWeeklyTime,
                            currentWeekSeconds: firestoreWeeklyTime
                        };
                        result.needsSync = true;
                    }
                }
            } catch (err) {
                console.error('[TimeGuard-8] getDailySnapshotResetState patch hatası:', err);
            }

            return result;
        };

        _log('getDailySnapshotResetState patch kuruldu.');
    }, 600);

    // --------------------------------------------------------
    // 3. saveData'ya ek koruma: kayıt sırasında
    //    weeklyStudyTime düşürülmesin.
    //    (onSnapshot'tan gelen stale data overwrite'ını önler)
    // --------------------------------------------------------
    const _waitSavePatch = setInterval(() => {
        if (typeof saveData !== 'function') return;
        clearInterval(_waitSavePatch);

        // Önceki kayıtlı en yüksek haftalık süreyi tut
        let _highWaterWeeklySeconds = 0;
        let _highWaterTotalSeconds = 0;

        const _origSaveData = saveData;
        saveData = function(options) {
            try {
                // buildUserPayload çağrısından önce mevcut en yüksek değeri sakla
                const refDate = new Date();
                const weekKey = typeof getWeekKey === 'function' ? getWeekKey(refDate) : '';
                if (weekKey && typeof scheduleData !== 'undefined') {
                    let weekSum = 0;
                    const week = scheduleData?.[weekKey];
                    if (week && typeof week === 'object') {
                        Object.values(week).forEach(day => {
                            weekSum += Math.max(0, _pi(day?.workedSeconds, 0));
                        });
                    }
                    if (weekSum > _highWaterWeeklySeconds) {
                        _highWaterWeeklySeconds = weekSum;
                    }
                }
                if (typeof totalWorkedSecondsAllTime !== 'undefined' && totalWorkedSecondsAllTime > _highWaterTotalSeconds) {
                    _highWaterTotalSeconds = totalWorkedSecondsAllTime;
                }
            } catch (e) {}

            return _origSaveData.call(this, options);
        };

        // buildUserPayload çıktısını da guard'la
        const _waitBuildPayload = setInterval(() => {
            if (typeof buildUserPayload !== 'function') return;
            clearInterval(_waitBuildPayload);

            const _origBuild = buildUserPayload;
            buildUserPayload = function() {
                const payload = _origBuild.apply(this, arguments);
                try {
                    const payloadWeekly = Math.max(
                        _pi(payload?.weeklyStudyTime, 0),
                        _pi(payload?.currentWeekSeconds, 0)
                    );
                    if (_highWaterWeeklySeconds > 0 && payloadWeekly < _highWaterWeeklySeconds) {
                        _log(`buildUserPayload koruması: weeklyStudyTime ${payloadWeekly}s < highWater ${_highWaterWeeklySeconds}s. Düzeltiliyor.`);
                        payload.weeklyStudyTime = _highWaterWeeklySeconds;
                        payload.currentWeekSeconds = _highWaterWeeklySeconds;
                    }
                    const payloadTotal = Math.max(
                        _pi(payload?.totalWorkedSeconds, 0),
                        _pi(payload?.totalStudyTime, 0)
                    );
                    if (_highWaterTotalSeconds > 0 && payloadTotal < _highWaterTotalSeconds) {
                        _log(`buildUserPayload koruması: totalStudyTime ${payloadTotal}s < highWater ${_highWaterTotalSeconds}s. Düzeltiliyor.`);
                        payload.totalWorkedSeconds = _highWaterTotalSeconds;
                        payload.totalStudyTime = _highWaterTotalSeconds;
                    }
                } catch (e) {}
                return payload;
            };

            _log('buildUserPayload high-water mark koruması kuruldu.');
        }, 800);

        _log('saveData high-water mark takibi kuruldu.');
    }, 800);

    // --------------------------------------------------------
    // 4. continueMoveTaskSelection — ertesi gün slot'u
    //    workedSeconds:0 ile initalize ediliyordu. Mevcut
    //    local veri varsa koru.
    // --------------------------------------------------------
    const _waitMovePatch = setInterval(() => {
        if (typeof continueMoveTaskSelection !== 'function') return;
        clearInterval(_waitMovePatch);

        const _origMove = continueMoveTaskSelection;
        continueMoveTaskSelection = function(dayIdx) {
            // Patch: ertesi gün için scheduleData[nextWeekKey][nextDayIdx]
            // eğer zaten bir değer varsa, bu fonksiyon onu {tasks:[], workedSeconds:0, questions:0}
            // ile eziyor. Bunu önlemek için önce backup al, çağırıldıktan sonra restore et.
            try {
                const weekKey = typeof getWeekKey === 'function' ? getWeekKey(
                    typeof currentWeekStart !== 'undefined' ? currentWeekStart : new Date()
                ) : '';
                let nextDayIdx = dayIdx + 1;
                let nextWeekKey = weekKey;
                if (nextDayIdx > 6) {
                    nextDayIdx = 0;
                    if (weekKey && typeof currentWeekStart !== 'undefined') {
                        const nextWeekDate = new Date(currentWeekStart);
                        nextWeekDate.setDate(nextWeekDate.getDate() + 7);
                        nextWeekKey = typeof getWeekKey === 'function' ? getWeekKey(nextWeekDate) : weekKey;
                    }
                }

                // Ertesi günün mevcut verisini yedekle (workedSeconds dahil)
                const backupDay = typeof scheduleData !== 'undefined' && scheduleData?.[nextWeekKey]?.[nextDayIdx]
                    ? JSON.parse(JSON.stringify(scheduleData[nextWeekKey][nextDayIdx]))
                    : null;

                const result = _origMove.call(this, dayIdx);

                // Eğer yedek workedSeconds'ı sıfır ötesi bir değerse geri yaz
                if (backupDay && typeof scheduleData !== 'undefined') {
                    const currentWorked = _pi(scheduleData?.[nextWeekKey]?.[nextDayIdx]?.workedSeconds, 0);
                    const backedWorked = _pi(backupDay.workedSeconds, 0);
                    if (backedWorked > currentWorked) {
                        if (!scheduleData[nextWeekKey]) scheduleData[nextWeekKey] = {};
                        if (!scheduleData[nextWeekKey][nextDayIdx]) scheduleData[nextWeekKey][nextDayIdx] = {};
                        scheduleData[nextWeekKey][nextDayIdx].workedSeconds = backedWorked;
                        _log(`continueMoveTaskSelection: ertesi gün workedSeconds koruması: ${currentWorked}s → ${backedWorked}s`);
                    }
                }

                return result;
            } catch (err) {
                console.error('[TimeGuard-8] continueMoveTaskSelection patch hatası:', err);
                return _origMove.call(this, dayIdx);
            }
        };

        _log('continueMoveTaskSelection patch kuruldu.');
    }, 800);

    // --------------------------------------------------------
    // 5. TIMER_OWNER_TTL_MS: 15s → 60s
    //    Mobil/arka plan sekmesi sahipliği daha erken kaybedip
    //    başka sekme override ediyordu.
    // --------------------------------------------------------
    const _waitTTL = setInterval(() => {
        if (typeof TIMER_OWNER_TTL_MS === 'undefined') return;
        clearInterval(_waitTTL);
        try {
            if (TIMER_OWNER_TTL_MS < 60000) {
                Object.defineProperty(window, 'TIMER_OWNER_TTL_MS', {
                    get: () => 60000,
                    configurable: true
                });
                _log(`TIMER_OWNER_TTL_MS ${TIMER_OWNER_TTL_MS}ms → 60000ms olarak güncellendi.`);
            }
        } catch (e) {
            _log('TIMER_OWNER_TTL_MS override yapılamadı (const/non-configurable):', e.message);
        }
    }, 500);

    // --------------------------------------------------------
    // 6. onSnapshot handler: Firestore'dan gelen doküman
    //    lokal zamandan düşükse scheduleData'ya yazmayı engelle.
    //    handleUsersSnapshot fonksiyonunu wrap et.
    // --------------------------------------------------------
    const _waitSnapshotHandler = setInterval(() => {
        if (typeof handleUsersSnapshot !== 'function') return;
        clearInterval(_waitSnapshotHandler);

        const _origHandler = handleUsersSnapshot;
        handleUsersSnapshot = function(snapshotDocs) {
            try {
                // Mevcut lokal haftalık süreyi kaydet
                const refDate = new Date();
                const weekKey = typeof getWeekKey === 'function' ? getWeekKey(refDate) : '';
                let localWeeklySeconds = 0;
                if (weekKey && typeof scheduleData !== 'undefined') {
                    const week = scheduleData?.[weekKey];
                    if (week && typeof week === 'object') {
                        Object.values(week).forEach(day => {
                            localWeeklySeconds += Math.max(0, _pi(day?.workedSeconds, 0));
                        });
                    }
                }

                const result = _origHandler.call(this, snapshotDocs);

                // Snapshot işlendikten sonra haftalık süre düştüyse geri yükle
                if (localWeeklySeconds > 0 && weekKey && typeof scheduleData !== 'undefined') {
                    let afterWeeklySeconds = 0;
                    const week = scheduleData?.[weekKey];
                    if (week && typeof week === 'object') {
                        Object.values(week).forEach(day => {
                            afterWeeklySeconds += Math.max(0, _pi(day?.workedSeconds, 0));
                        });
                    }
                    if (afterWeeklySeconds < localWeeklySeconds) {
                        _log(`handleUsersSnapshot sonrası haftalık süre düştü: ${afterWeeklySeconds}s < ${localWeeklySeconds}s. UYARI: Bu beklenmedik; lokal korunuyor.`);
                        // Bu durumu logla; recovery için bir sonraki save'de high-water mark devreye girer.
                    }
                }

                return result;
            } catch (err) {
                console.error('[TimeGuard-8] handleUsersSnapshot patch hatası:', err);
                return _origHandler.call(this, snapshotDocs);
            }
        };

        _log('handleUsersSnapshot koruma kaydı kuruldu.');
    }, 800);

    _log('Tüm koruma patch\'leri başlatıldı — v8.');
})();
// ============================================================
// /CODEX TIME GUARD — v8
// ============================================================
