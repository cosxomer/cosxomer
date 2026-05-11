// ============================================================
// CODEX TURKEY RESET FIX — v8
// Günlük (00:00) ve haftalık (Pazar→Pazartesi 00:00) sıfırlama
// her zaman Türkiye saatine (Europe/Istanbul, UTC+3) göre çalışır.
//
// Düzeltilen sorunlar:
//   1. getCurrentDayMeta / getWeekKey / getInlineDateKey
//      cihazın yerel saatini kullanıyor. Yurt dışı veya
//      yanlış sistem saatindeki kullanıcılarda reset zamanı
//      kayıyor. FIX: Tüm tarih/saat işlemleri için
//      getTRDate() yardımcısı eklendi; ilgili fonksiyonlar
//      wrap edildi.
//
//   2. calendarBoundaryInterval → document.hidden ise
//      interval callback hiç çalışmıyor. Kullanıcı sayfayı
//      arka planda bırakıp ertesi gün gelince reset tetiklenmez.
//      FIX: visibilitychange event'ında da boundary kontrolü
//      yapılıyor. Ayrıca interval 60s → 30s'ye indirildi.
//
//   3. Haftalık reset Pazar→Pazartesi geçişinde
//      (TR saatiyle 00:00) weekKey değişiyor ama weeklyStudyTime
//      hemen 0'a çekilmiyor; eski hafta verisi yeni hafta için
//      de gösteriliyor. FIX: weekKey değişince weeklyStudyTime
//      kesin olarak 0'a sıfırlanıyor ve Firestore'a yazılıyor.
// ============================================================

(() => {
    'use strict';

    const TR_TZ = 'Europe/Istanbul';

    // ── Türkiye saatiyle şimdiki anı Date olarak döndür ──────
    // Trick: Intl.DateTimeFormat ile TR saatini parçalarına ayır,
    // sonra UTC Date objesine dönüştür. Bu sayede .getDay(),
    // .getFullYear() vb. metodlar TR saatini verir.
    function getTRDate(inputDate) {
        const src = inputDate instanceof Date ? inputDate : new Date();
        try {
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: TR_TZ,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false
            }).formatToParts(src);

            const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
            // hour12:false ile saat 24 olarak gelebilir → 0'a normalize
            const h = get('hour') === 24 ? 0 : get('hour');
            return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'), get('second')));
        } catch (e) {
            // Intl desteklenmiyorsa UTC+3 sabit offset
            return new Date(src.getTime() + 3 * 3600 * 1000);
        }
    }

    // TR saatiyle "YYYY-MM-DD" döndür
    function getTRDateKey(inputDate) {
        const d = getTRDate(inputDate);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    // TR saatiyle ISO hafta numarası (Pazartesi başlangıçlı)
    function getTRWeekKey(inputDate) {
        const d = getTRDate(inputDate);
        // ISO haftası: Perşembe'ye hizala
        const thu = new Date(Date.UTC(
            d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()
        ));
        thu.setUTCDate(thu.getUTCDate() + 3 - ((thu.getUTCDay() + 6) % 7));
        const weekYear = thu.getUTCFullYear();
        const firstThu = new Date(Date.UTC(weekYear, 0, 4));
        firstThu.setUTCDate(firstThu.getUTCDate() + 3 - ((firstThu.getUTCDay() + 6) % 7));
        const weekNum = 1 + Math.round((thu.getTime() - firstThu.getTime()) / 604800000);
        return `${weekYear}-W${weekNum}`;
    }

    // TR saatiyle dayIdx (Pazartesi=0 … Pazar=6)
    function getTRDayIdx(inputDate) {
        const d = getTRDate(inputDate);
        return (d.getUTCDay() + 6) % 7;
    }

    function _log(...a) { console.log('[TurkeyResetFix-8]', ...a); }

    // ── getCurrentDayMeta PATCH ───────────────────────────────
    const _waitMeta = setInterval(() => {
        if (typeof getCurrentDayMeta !== 'function') return;
        clearInterval(_waitMeta);

        const _orig = getCurrentDayMeta;
        getCurrentDayMeta = function(date) {
            const ref = date instanceof Date ? date : new Date();
            return {
                dateKey: getTRDateKey(ref),
                weekKey: getTRWeekKey(ref),
                dayIdx: getTRDayIdx(ref)
            };
        };

        _log('getCurrentDayMeta → TR saat dilimine patch edildi.');
    }, 100);

    // ── getWeekKey PATCH ─────────────────────────────────────
    // index.html içindeki inline getWeekKey de var; onu da patch et
    const _waitWeekKey = setInterval(() => {
        if (typeof getWeekKey !== 'function') return;
        clearInterval(_waitWeekKey);

        const _origWK = getWeekKey;
        getWeekKey = function(date) {
            const ref = date instanceof Date ? date : new Date();
            return getTRWeekKey(ref);
        };

        _log('getWeekKey → TR saat dilimine patch edildi.');
    }, 100);

    // ── getInlineDateKey PATCH ───────────────────────────────
    const _waitInline = setInterval(() => {
        if (typeof getInlineDateKey !== 'function') return;
        clearInterval(_waitInline);

        getInlineDateKey = function(referenceDate) {
            return getTRDateKey(referenceDate instanceof Date ? referenceDate : new Date());
        };

        _log('getInlineDateKey → TR saat dilimine patch edildi.');
    }, 200);

    // ── calendarBoundaryInterval düzeltmesi ──────────────────
    // 1. document.hidden kontrolü kaldırılıyor (arka plan fix)
    // 2. visibilitychange event'ında anlık kontrol ekleniyor
    // 3. Interval 30s'ye indirildi
    const _waitBoundary = setInterval(() => {
        if (typeof ensureCalendarBoundaryWatcher !== 'function') return;
        if (typeof calendarBoundaryInterval === 'undefined') return;
        clearInterval(_waitBoundary);

        const _origWatcher = ensureCalendarBoundaryWatcher;

        ensureCalendarBoundaryWatcher = function() {
            // Var olan interval'ı temizle, yenisini kur
            if (typeof calendarBoundaryInterval !== 'undefined' && calendarBoundaryInterval) {
                clearInterval(calendarBoundaryInterval);
                window.calendarBoundaryInterval = null;
            }

            if (typeof lastObservedCalendarMeta !== 'undefined') {
                window.lastObservedCalendarMeta = getCurrentDayMeta(new Date());
            }

            const _checkBoundary = () => {
                // document.hidden kontrolü YOK — arka planda da çalışsın
                const nowDate = new Date();
                const nextMeta = getCurrentDayMeta(nowDate);
                const prev = typeof lastObservedCalendarMeta !== 'undefined' ? lastObservedCalendarMeta : null;
                if (
                    !prev
                    || nextMeta.dateKey !== prev.dateKey
                    || nextMeta.weekKey !== prev.weekKey
                ) {
                    _log('Takvim sınırı geçildi (TR saati):', prev?.dateKey, '→', nextMeta.dateKey);
                    if (typeof handleCalendarBoundaryChange === 'function') {
                        window.lastObservedCalendarMeta = handleCalendarBoundaryChange(prev, nowDate);
                    } else {
                        window.lastObservedCalendarMeta = nextMeta;
                    }
                    // Haftalık reset: weekKey değiştiyse weeklyStudyTime=0 yaz
                    if (prev && nextMeta.weekKey !== prev.weekKey) {
                        _log('Haftalık sıfırlama (Pazar→Pazartesi TR saati).');
                        _applyWeeklyReset(nextMeta);
                    }
                }
            };

            window.calendarBoundaryInterval = setInterval(_checkBoundary, 30000); // 30s

            // visibilitychange: sekme ön plana gelince anında kontrol
            document.removeEventListener('visibilitychange', _onVisibility);
            document.addEventListener('visibilitychange', _onVisibility);

            _log('calendarBoundaryInterval TR saatine göre yeniden kuruldu (30s, arka plan destekli).');
        };

        function _onVisibility() {
            if (!document.hidden) {
                _log('Sekme ön plana geldi, takvim sınırı anlık kontrol ediliyor.');
                const nowDate = new Date();
                const nextMeta = getCurrentDayMeta(nowDate);
                const prev = typeof lastObservedCalendarMeta !== 'undefined' ? lastObservedCalendarMeta : null;
                if (!prev || nextMeta.dateKey !== prev.dateKey || nextMeta.weekKey !== prev.weekKey) {
                    if (typeof handleCalendarBoundaryChange === 'function') {
                        window.lastObservedCalendarMeta = handleCalendarBoundaryChange(prev, nowDate);
                    }
                    if (prev && nextMeta.weekKey !== prev.weekKey) {
                        _applyWeeklyReset(nextMeta);
                    }
                }
            }
        }

        // Haftalık sıfırlama uygulayıcı
        function _applyWeeklyReset(newMeta) {
            try {
                // scheduleData'daki yeni hafta slot'u yoksa oluştur
                if (typeof scheduleData !== 'undefined') {
                    if (!scheduleData[newMeta.weekKey]) {
                        scheduleData[newMeta.weekKey] = {};
                    }
                }
                // weeklyStudyTime'ı sıfırla
                if (typeof weeklyStudyTime !== 'undefined') window.weeklyStudyTime = 0;
                if (typeof currentUserLiveDoc !== 'undefined' && currentUserLiveDoc) {
                    currentUserLiveDoc.weeklyStudyTime = 0;
                    currentUserLiveDoc.currentWeekSeconds = 0;
                    currentUserLiveDoc.weeklyStudyWeekKey = newMeta.weekKey;
                }
                // Firestore'a yaz
                if (typeof queueAutoDailyResetSync === 'function') {
                    queueAutoDailyResetSync(new Date());
                } else if (typeof saveData === 'function') {
                    setTimeout(() => saveData({ authorized: true, immediate: true }), 500);
                }
                // UI yenile
                if (typeof refreshCurrentTotals === 'function') refreshCurrentTotals();
                if (typeof renderSchedule === 'function') renderSchedule();
                if (typeof updateLiveStudyPreview === 'function') updateLiveStudyPreview();
                if (typeof refreshLeaderboardOptimistically === 'function') refreshLeaderboardOptimistically(null);
                _log('Haftalık sıfırlama tamamlandı. Yeni weekKey:', newMeta.weekKey);
            } catch (e) {
                console.error('[TurkeyResetFix-8] Haftalık sıfırlama hatası:', e);
            }
        }

        // Mevcut watcher'ı hemen yenisiyle değiştir
        ensureCalendarBoundaryWatcher();

        _log('ensureCalendarBoundaryWatcher patch kuruldu.');
    }, 500);

    // ── Günlük sıfırlama için Firestore'a TR saatiyle dailyStudyDateKey yaz ─
    // saveData çağrısında dailyStudyDateKey her zaman TR dateKey olmalı
    const _waitSavePatch = setInterval(() => {
        if (typeof buildUserPayload !== 'function') return;
        clearInterval(_waitSavePatch);

        const _origBuild = buildUserPayload;
        buildUserPayload = function() {
            const payload = _origBuild.apply(this, arguments);
            try {
                const trDateKey = getTRDateKey(new Date());
                const trWeekKey = getTRWeekKey(new Date());
                if (payload) {
                    // dailyStudyDateKey her zaman TR saati
                    if (payload.dailyStudyDateKey && payload.dailyStudyDateKey !== trDateKey) {
                        _log(`dailyStudyDateKey düzeltiliyor: ${payload.dailyStudyDateKey} → ${trDateKey}`);
                    }
                    payload.dailyStudyDateKey = trDateKey;
                    payload.todayDateKey = trDateKey;
                    // weeklyStudyWeekKey her zaman TR haftası
                    payload.weeklyStudyWeekKey = trWeekKey;
                }
            } catch (e) {}
            return payload;
        };

        _log('buildUserPayload TR dateKey/weekKey fix kuruldu.');
    }, 600);

    // ── Sayfa yüklenince hemen boundary kontrolü ─────────────
    window.addEventListener('load', () => {
        setTimeout(() => {
            try {
                const nowDate = new Date();
                const trMeta = getCurrentDayMeta(nowDate);
                const prev = typeof lastObservedCalendarMeta !== 'undefined' ? lastObservedCalendarMeta : null;
                if (prev && (trMeta.dateKey !== prev.dateKey || trMeta.weekKey !== prev.weekKey)) {
                    _log('Sayfa yüklenince gün/hafta geçişi tespit edildi:', prev, '→', trMeta);
                    if (typeof handleCalendarBoundaryChange === 'function') {
                        window.lastObservedCalendarMeta = handleCalendarBoundaryChange(prev, nowDate);
                    }
                }
            } catch (e) {}
        }, 2000);
    });

    _log('TR saat dilimi reset fix başlatıldı — v8.');
})();
// ============================================================
// /CODEX TURKEY RESET FIX — v8
// ============================================================
