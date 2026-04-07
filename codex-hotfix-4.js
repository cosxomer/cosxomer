(() => {
    const SUPPORT_COLLECTION = 'supportMessages';

    function isFirestorePermissionError(error) {
        const code = String(error?.code || "").toLowerCase();
        const message = String(error?.message || "").toLowerCase();
        return code === "permission-denied" || message.includes("insufficient permissions");
    }

    function toSupportTimestamp(value) {
        const ms = value ? new Date(value).getTime() : 0;
        return Number.isFinite(ms) ? ms : 0;
    }

    function getSupportVersion(message = {}) {
        return Math.max(
            toSupportTimestamp(message.updatedAt),
            toSupportTimestamp(message.deletedAt),
            toSupportTimestamp(message.repliedAt),
            toSupportTimestamp(message.timestamp)
        );
    }

    function normalizeSupportRecord(rawMessage, options = {}) {
        const base = normalizeSupportMessage(rawMessage || {}, rawMessage?.id || options.fallbackId || createSupportMessageId());
        const ownerDocId = rawMessage?.ownerDocId || options.ownerDocId || base.senderId || "";
        return {
            ...base,
            id: base.id || options.fallbackId || createSupportMessageId(),
            ownerDocId,
            senderId: base.senderId || ownerDocId,
            senderUsername: base.senderUsername || options.defaultUsername || "Kullanici",
            visibility: 'private',
            updatedAt: rawMessage?.updatedAt || base.repliedAt || rawMessage?.timestamp || base.timestamp || new Date().toISOString(),
            deletedForOwner: !!rawMessage?.deletedForOwner,
            deletedForAdmin: !!rawMessage?.deletedForAdmin,
            deletedForEveryone: !!rawMessage?.deletedForEveryone,
            deletedAt: rawMessage?.deletedAt || "",
            hasUserDoc: !!options.hasUserDoc || !!rawMessage?.hasUserDoc,
            hasCollection: !!options.hasCollection || !!rawMessage?.hasCollection,
            collectionDocId: options.collectionDocId || rawMessage?.collectionDocId || ""
        };
    }

    function mergeSupportRecords(existing, incoming) {
        const newer = getSupportVersion(incoming) >= getSupportVersion(existing) ? incoming : existing;
        const older = newer === incoming ? existing : incoming;
        return {
            ...older,
            ...newer,
            id: newer.id || older.id,
            ownerDocId: newer.ownerDocId || older.ownerDocId || newer.senderId || older.senderId || "",
            senderId: newer.senderId || older.senderId || newer.ownerDocId || older.ownerDocId || "",
            senderUsername: newer.senderUsername || older.senderUsername || "Kullanici",
            message: newer.message || older.message || "",
            timestamp: newer.timestamp || older.timestamp || new Date().toISOString(),
            read: typeof newer.read === 'boolean' ? newer.read : !!older.read,
            adminReply: newer.adminReply || older.adminReply || "",
            repliedAt: newer.repliedAt || older.repliedAt || "",
            repliedBy: newer.repliedBy || older.repliedBy || "",
            adminId: newer.adminId || older.adminId || "",
            updatedAt: newer.updatedAt || older.updatedAt || newer.repliedAt || older.repliedAt || newer.timestamp || older.timestamp || new Date().toISOString(),
            deletedForOwner: !!(newer.deletedForOwner || older.deletedForOwner),
            deletedForAdmin: !!(newer.deletedForAdmin || older.deletedForAdmin),
            deletedForEveryone: !!(newer.deletedForEveryone || older.deletedForEveryone),
            deletedAt: newer.deletedAt || older.deletedAt || "",
            hasUserDoc: !!(existing.hasUserDoc || incoming.hasUserDoc),
            hasCollection: !!(existing.hasCollection || incoming.hasCollection),
            collectionDocId: incoming.collectionDocId || existing.collectionDocId || incoming.id || existing.id || ""
        };
    }

    function combineSupportRecords(records) {
        const mergedRecords = new Map();

        (records || []).forEach(record => {
            if (!record?.id) return;
            const normalizedRecord = normalizeSupportRecord(record, {
                fallbackId: record.id,
                ownerDocId: record.ownerDocId || record.senderId,
                defaultUsername: record.senderUsername || "Kullanici"
            });
            const existingRecord = mergedRecords.get(normalizedRecord.id);
            mergedRecords.set(
                normalizedRecord.id,
                existingRecord ? mergeSupportRecords(existingRecord, normalizedRecord) : normalizedRecord
            );
        });

        return [...mergedRecords.values()].sort((a, b) => getSupportVersion(b) - getSupportVersion(a));
    }

    function isSupportMessageVisible(message, adminView) {
        if (!message || (!message.message && !message.adminReply)) return false;
        if (message.deletedForEveryone) return false;
        if (adminView) return !message.deletedForAdmin;
        return message.senderId === currentUser?.uid && !message.deletedForOwner;
    }

    function serializeSupportMessageForUserDoc(message) {
        return {
            id: message.id,
            senderId: message.senderId || message.ownerDocId || "",
            senderUsername: message.senderUsername || "Kullanici",
            message: message.message || "",
            timestamp: message.timestamp || new Date().toISOString(),
            read: !!message.read,
            adminId: message.adminId || "",
            visibility: 'private',
            adminReply: message.adminReply || "",
            repliedAt: message.repliedAt || "",
            repliedBy: message.repliedBy || "",
            updatedAt: message.updatedAt || message.timestamp || new Date().toISOString(),
            deletedForOwner: !!message.deletedForOwner,
            deletedForAdmin: !!message.deletedForAdmin,
            deletedForEveryone: !!message.deletedForEveryone,
            deletedAt: message.deletedAt || ""
        };
    }

    function serializeSupportMessageForCollection(message) {
        return {
            ...serializeSupportMessageForUserDoc(message),
            id: message.id,
            ownerDocId: message.ownerDocId || message.senderId || ""
        };
    }

    async function readOwnerSupportContext(ownerDocId, fallbackUsername = "Kullanici") {
        const ownerRef = db.collection('users').doc(ownerDocId);
        const ownerDoc = await ownerRef.get();
        const ownerData = ownerDoc.exists ? (ownerDoc.data() || {}) : { username: fallbackUsername, supportMessages: [] };
        const messages = normalizeOwnerSupportMessages(
            ownerData.supportMessages || [],
            ownerDocId,
            ownerData.username || fallbackUsername
        ).map(item => normalizeSupportRecord(item, {
            ownerDocId,
            defaultUsername: ownerData.username || fallbackUsername,
            hasUserDoc: true
        }));

        return {
            ownerRef,
            ownerData,
            messages
        };
    }

    async function loadUserDocSupportMessagesForCurrentContext() {
        if (!currentUser) return [];

        try {
            if (isCurrentAdmin()) {
                const usersSnapshot = await db.collection('users').get();
                return usersSnapshot.docs.flatMap(doc => {
                    const data = doc.data() || {};
                    return normalizeOwnerSupportMessages(
                        data.supportMessages || [],
                        doc.id,
                        data.username || "Kullanici"
                    ).map(item => normalizeSupportRecord(item, {
                        ownerDocId: doc.id,
                        defaultUsername: data.username || "Kullanici",
                        hasUserDoc: true
                    }));
                });
            }

            const ownerContext = await readOwnerSupportContext(currentUser.uid, currentUsername || "Kullanici");
            return ownerContext.messages;
        } catch (error) {
            if (isFirestorePermissionError(error)) {
                console.warn("Kullanici destek kayitlari Firestore kurallari nedeniyle toplu okunamadi. Yerel kayitlar gosterilecek.");
                const ownerContext = await readOwnerSupportContext(currentUser.uid, currentUsername || "Kullanici").catch(() => ({ messages: [] }));
                return ownerContext.messages || [];
            }

            console.error("Kullanici destek kayitlari okunamadi:", error);
            return [];
        }
    }

    async function loadCollectionSupportMessagesForCurrentContext() {
        if (!currentUser) return [];

        let snapshot = null;

        try {
            if (isCurrentAdmin()) {
                try {
                    snapshot = await db.collection(SUPPORT_COLLECTION).orderBy('timestamp', 'desc').get();
                } catch (orderError) {
                    snapshot = await db.collection(SUPPORT_COLLECTION).get();
                }
            } else {
                try {
                    snapshot = await db.collection(SUPPORT_COLLECTION).where('senderId', '==', currentUser.uid).get();
                } catch (queryError) {
                    snapshot = await db.collection(SUPPORT_COLLECTION).get();
                }
            }
        } catch (error) {
            if (isFirestorePermissionError(error)) {
                console.warn("Destek koleksiyonu Firestore kurallari nedeniyle okunamadi.");
                return [];
            }

            console.error("Destek koleksiyonu okunamadi:", error);
            return [];
        }

        return snapshot.docs
            .map(doc => {
                const rawData = doc.data() || {};
                return normalizeSupportRecord(rawData, {
                    fallbackId: doc.id,
                    ownerDocId: rawData.ownerDocId || rawData.senderId || "",
                    defaultUsername: rawData.senderUsername || "Kullanici",
                    hasCollection: true,
                    collectionDocId: doc.id
                });
            })
            .filter(item => isCurrentAdmin() || item.senderId === currentUser.uid || item.ownerDocId === currentUser.uid);
    }

    async function attemptSupportWrite(logLabel, action) {
        try {
            const value = await action();
            return { ok: true, value };
        } catch (error) {
            console.error(logLabel, error);
            return { ok: false, error };
        }
    }

    function parseSupportInteger(value, fallback = 0) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function getTodayTimerResetMeta() {
        const now = new Date();
        return {
            now,
            dateKey: now.toLocaleDateString("sv-SE"),
            weekKey: typeof getWeekKey === "function" ? getWeekKey(now) : "",
            dayIdx: (now.getDay() + 6) % 7
        };
    }

    function cloneScheduleWithTodayReset(schedule, weekKey, dayIdx) {
        const nextSchedule = JSON.parse(JSON.stringify(schedule || {}));
        if (!nextSchedule[weekKey]) nextSchedule[weekKey] = {};

        const dayKey = String(dayIdx);
        const currentDay = nextSchedule[weekKey][dayKey] || nextSchedule[weekKey][dayIdx] || {};
        nextSchedule[weekKey][dayKey] = {
            ...currentDay,
            workedSeconds: 0
        };

        return nextSchedule;
    }

    function getWorkedSecondsTotal(schedule) {
        if (typeof calculateTotalWorkedSecondsFromSchedule === "function") {
            return calculateTotalWorkedSecondsFromSchedule(schedule || {});
        }

        let total = 0;
        Object.values(schedule || {}).forEach(week => {
            Object.values(week || {}).forEach(day => {
                total += parseSupportInteger(day?.workedSeconds, 0);
            });
        });
        return total;
    }

    function createAdminTimerResetMarker(resetMeta) {
        const requestedAt = resetMeta?.now instanceof Date ? resetMeta.now : new Date();
        const requestedAtMs = requestedAt.getTime();
        return {
            token: `admin_reset_${requestedAtMs}_${Math.random().toString(36).slice(2, 8)}`,
            dateKey: resetMeta?.dateKey || requestedAt.toLocaleDateString("sv-SE"),
            requestedAt: requestedAt.toISOString(),
            requestedAtMs,
            requestedBy: currentUsername || ADMIN_USERNAME,
            requestedByEmail: currentUser?.email || ADMIN_EMAIL
        };
    }

    function buildTodayTimerResetPatch(userData, resetMeta, resetMarker) {
        const nextSchedule = cloneScheduleWithTodayReset(userData?.schedule || {}, resetMeta.weekKey, resetMeta.dayIdx);
        const totalWorkedSeconds = getWorkedSecondsTotal(nextSchedule);

        return {
            schedule: nextSchedule,
            totalWorkedSeconds,
            totalStudyTime: totalWorkedSeconds,
            dailyStudyTime: 0,
            currentSessionTime: 0,
            activeTimer: null,
            isWorking: false,
            lastTimerSyncAt: resetMarker.requestedAtMs,
            adminTimerReset: resetMarker
        };
    }

    async function commitTimerResetPatches(patches) {
        if (!patches.length) return;

        const chunkSize = 400;
        for (let index = 0; index < patches.length; index += chunkSize) {
            const batch = db.batch();
            patches.slice(index, index + chunkSize).forEach(item => {
                batch.set(item.ref, item.patch, { merge: true });
            });
            await batch.commit();
        }
    }

    let adminTimeAdjustmentUserChoices = [];
    let adminTimeAdjustmentUserChoicesPromise = null;

    function escapeAdminTimeAdjustmentHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeAdminTimeAdjustmentScope(scope) {
        return ['today', 'yesterday', 'week', 'total'].includes(scope) ? scope : 'today';
    }

    function getAdminTimeAdjustmentScopeLabel(scope) {
        switch (normalizeAdminTimeAdjustmentScope(scope)) {
            case 'yesterday':
                return 'Dun';
            case 'week':
                return 'Haftalik';
            case 'total':
                return 'Toplam';
            default:
                return 'Bugun';
        }
    }

    function formatAdminAdjustmentDuration(seconds = 0) {
        const safeSeconds = Math.max(0, parseAdminTimeValue(seconds, 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        return `${hours}s ${minutes}dk`;
    }

    function cloneAdminScheduleData(existingSchedule = {}) {
        const nextSchedule = {};

        Object.entries(existingSchedule || {}).forEach(([weekKey, weekData]) => {
            nextSchedule[weekKey] = {};
            Object.entries(weekData || {}).forEach(([dayIdx, rawDay]) => {
                nextSchedule[weekKey][String(dayIdx)] = rawDay && typeof rawDay === 'object'
                    ? JSON.parse(JSON.stringify(rawDay))
                    : {};
            });
        });

        return nextSchedule;
    }

    function ensureAdminScheduleDay(schedule = {}, weekKey = '', dayIdx = 0) {
        if (!schedule[weekKey] || typeof schedule[weekKey] !== 'object') {
            schedule[weekKey] = {};
        }

        const dayKey = String(dayIdx);
        const currentDay = schedule[weekKey][dayKey] && typeof schedule[weekKey][dayKey] === 'object'
            ? schedule[weekKey][dayKey]
            : {};

        schedule[weekKey][dayKey] = {
            ...currentDay,
            workedSeconds: Math.max(0, parseAdminTimeValue(currentDay.workedSeconds, 0))
        };

        return schedule[weekKey][dayKey];
    }

    function getAdminScheduleDayWorkedSeconds(schedule = {}, weekKey = '', dayIdx = 0) {
        return Math.max(0, parseAdminTimeValue(schedule?.[weekKey]?.[String(dayIdx)]?.workedSeconds, 0));
    }

    function getAdminScheduleWeekWorkedSeconds(schedule = {}, weekKey = '') {
        return Object.values(schedule?.[weekKey] || {}).reduce((total, rawDay) => {
            return total + Math.max(0, parseAdminTimeValue(rawDay?.workedSeconds, 0));
        }, 0);
    }

    function collectAdminScheduleEntries(schedule = {}, predicate = null) {
        const entries = [];

        Object.entries(schedule || {}).forEach(([weekKey, weekData]) => {
            Object.entries(weekData || {}).forEach(([dayIdx, rawDay]) => {
                const entry = {
                    weekKey,
                    dayIdx: String(dayIdx),
                    workedSeconds: Math.max(0, parseAdminTimeValue(rawDay?.workedSeconds, 0))
                };

                if (!predicate || predicate(entry)) {
                    entries.push(entry);
                }
            });
        });

        return entries;
    }

    function redistributeWorkedSecondsAcrossEntries(schedule = {}, entries = [], targetSeconds = 0, fallbackMeta = {}) {
        const safeTarget = Math.max(0, parseAdminTimeValue(targetSeconds, 0));
        const normalizedEntries = Array.isArray(entries) ? [...entries] : [];

        normalizedEntries.forEach(entry => {
            ensureAdminScheduleDay(schedule, entry.weekKey, entry.dayIdx).workedSeconds = 0;
        });

        if (safeTarget === 0) {
            return;
        }

        const fallbackWeekKey = String(fallbackMeta.weekKey || '');
        const fallbackDayIdx = String(fallbackMeta.dayIdx ?? 0);
        const totalBeforeScale = normalizedEntries.reduce((sum, entry) => sum + Math.max(0, parseAdminTimeValue(entry.workedSeconds, 0)), 0);

        if (!normalizedEntries.length || totalBeforeScale <= 0) {
            ensureAdminScheduleDay(schedule, fallbackWeekKey, fallbackDayIdx).workedSeconds = safeTarget;
            return;
        }

        const scaledEntries = normalizedEntries.map((entry, index) => {
            const exactValue = (Math.max(0, entry.workedSeconds) / totalBeforeScale) * safeTarget;
            const baseValue = Math.floor(exactValue);
            return {
                ...entry,
                index,
                baseValue,
                fraction: exactValue - baseValue
            };
        });

        let remainingSeconds = safeTarget - scaledEntries.reduce((sum, entry) => sum + entry.baseValue, 0);

        scaledEntries.sort((a, b) => {
            const aIsFallback = a.weekKey === fallbackWeekKey && a.dayIdx === fallbackDayIdx ? 1 : 0;
            const bIsFallback = b.weekKey === fallbackWeekKey && b.dayIdx === fallbackDayIdx ? 1 : 0;
            if (b.fraction !== a.fraction) return b.fraction - a.fraction;
            if (bIsFallback !== aIsFallback) return bIsFallback - aIsFallback;
            if (b.workedSeconds !== a.workedSeconds) return b.workedSeconds - a.workedSeconds;
            return a.index - b.index;
        });

        scaledEntries.forEach(entry => {
            ensureAdminScheduleDay(schedule, entry.weekKey, entry.dayIdx).workedSeconds = entry.baseValue;
        });

        for (let index = 0; index < remainingSeconds; index += 1) {
            const targetEntry = scaledEntries[index % scaledEntries.length];
            ensureAdminScheduleDay(schedule, targetEntry.weekKey, targetEntry.dayIdx).workedSeconds += 1;
        }
    }

    function ensureAdminTimerResetControls() {
        const adminSummary = document.getElementById('support-admin-summary');
        if (!adminSummary) return { panel: null, button: null, status: null };

        let panel = document.getElementById('support-admin-reset-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'support-admin-reset-panel';
            panel.style.cssText = 'display:flex; flex-direction:column; gap:10px; margin-top:14px;';
            panel.innerHTML = `
                <button id="support-admin-reset-today-btn" type="button" style="display:inline-flex; align-items:center; justify-content:center; gap:10px; padding:12px 16px; border:none; border-radius:14px; background:linear-gradient(135deg, var(--countdown-fill), var(--accent-color)); color:var(--header-text); font-weight:700; box-shadow:0 10px 24px rgba(0,0,0,0.18); cursor:pointer;">
                    <i class="fas fa-stopwatch"></i>
                    <span>Bugunku Sureleri Sifirla</span>
                </button>
                <div id="support-admin-time-adjust-panel" style="display:flex; flex-direction:column; gap:10px; padding:14px; border-radius:16px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08);">
                    <div style="font-weight:700;">Tek Kullanici Suresi Ayarla</div>
                    <div style="font-size:0.88rem; line-height:1.45; opacity:0.78;">Ayni isimli kullanicilari karistirmamak icin asagidaki listeden sec. Sureyi bugun, dun, bu hafta veya toplam bazda ayarlayabilirsin.</div>
                    <input id="support-admin-time-target" type="text" placeholder="Kullanici adi veya e-posta" style="width:100%; padding:11px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:rgba(15,23,42,0.55); color:var(--header-text);">
                    <div id="support-admin-time-selected" style="display:none; padding:10px 12px; border-radius:12px; background:rgba(37,99,235,0.16); border:1px solid rgba(37,99,235,0.3); font-size:0.88rem; line-height:1.45;"></div>
                    <div id="support-admin-time-user-results" style="display:flex; flex-direction:column; gap:8px; max-height:220px; overflow:auto; padding-right:2px;"></div>
                    <select id="support-admin-time-scope" style="width:100%; padding:11px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:rgba(15,23,42,0.55); color:var(--header-text);">
                        <option value="today">Bugun</option>
                        <option value="yesterday">Dün</option>
                        <option value="week">Haftalik</option>
                        <option value="total">Toplam</option>
                    </select>
                    <div style="display:flex; gap:10px;">
                        <input id="support-admin-time-hours" type="number" min="0" max="999" value="1" placeholder="Saat" style="flex:1; padding:11px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:rgba(15,23,42,0.55); color:var(--header-text);">
                        <input id="support-admin-time-minutes" type="number" min="0" max="59" value="0" placeholder="Dakika" style="flex:1; padding:11px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:rgba(15,23,42,0.55); color:var(--header-text);">
                    </div>
                    <button id="support-admin-time-apply-btn" type="button" style="display:inline-flex; align-items:center; justify-content:center; gap:10px; padding:11px 14px; border:none; border-radius:12px; background:linear-gradient(135deg, #2563eb, #0ea5e9); color:var(--header-text); font-weight:700; cursor:pointer;">
                        <i class="fas fa-sliders-h"></i>
                        <span>Bu Kullaniciya Sureyi Uygula</span>
                    </button>
                    <button id="support-admin-user-remove-btn" type="button" style="display:inline-flex; align-items:center; justify-content:center; gap:10px; padding:11px 14px; border:none; border-radius:12px; background:linear-gradient(135deg, #b91c1c, #ef4444); color:var(--header-text); font-weight:700; cursor:pointer;">
                        <i class="fas fa-user-times"></i>
                        <span>Bu Kullanici Kaydini Kaldir</span>
                    </button>
                </div>
                <div id="support-admin-reset-status" style="font-size:0.92rem; line-height:1.5; opacity:0.82;">
                    Bu islem, diger kullanicilarin sadece bugune ait calisma suresini sifirlar ve acik timerlarini kapatir.
                </div>
            `;
            adminSummary.appendChild(panel);
        }

        const button = document.getElementById('support-admin-reset-today-btn');
        const status = document.getElementById('support-admin-reset-status');

        if (button && !button.dataset.bound) {
            button.dataset.bound = '1';
            button.addEventListener('click', resetAllUsersTimersForToday);
        }

        const applyButton = document.getElementById('support-admin-time-apply-btn');
        if (applyButton && !applyButton.dataset.bound) {
            applyButton.dataset.bound = '1';
            applyButton.addEventListener('click', applyAdminTimeAdjustmentFromControls);
        }

        const removeButton = document.getElementById('support-admin-user-remove-btn');
        if (removeButton && !removeButton.dataset.bound) {
            removeButton.dataset.bound = '1';
            removeButton.addEventListener('click', removeAdminUserRecordFromControls);
        }

        const targetInput = document.getElementById('support-admin-time-target');
        if (targetInput && !targetInput.dataset.bound) {
            targetInput.dataset.bound = '1';
            targetInput.addEventListener('focus', () => {
                renderAdminTimeAdjustmentUserMatches(targetInput.value).catch(error => {
                    console.error('Admin kullanici listesi acilamadi:', error);
                });
            });
            targetInput.addEventListener('input', () => {
                clearAdminTimeAdjustmentSelection({ preserveInput: true });
                renderAdminTimeAdjustmentUserMatches(targetInput.value).catch(error => {
                    console.error('Admin kullanici aramasi basarisiz:', error);
                });
            });
        }

        const results = document.getElementById('support-admin-time-user-results');
        if (results && !results.dataset.bound) {
            results.dataset.bound = '1';
            results.addEventListener('click', event => {
                const choiceButton = event.target?.closest?.('[data-admin-time-user-uid]');
                if (!choiceButton) return;

                const selectedUid = String(choiceButton.dataset.adminTimeUserUid || '');
                if (!selectedUid) return;

                const selectedUser = adminTimeAdjustmentUserChoices.find(user => user.uid === selectedUid);
                if (!selectedUser) return;

                setAdminTimeAdjustmentSelection(selectedUser);
                renderAdminTimeAdjustmentUserMatches(targetInput?.value || '').catch(error => {
                    console.error('Admin secim listesi yenilenemedi:', error);
                });
            });
        }

        return { panel, button, status };
    }

    function setAdminTimerResetStatus(message, isError = false) {
        const controls = ensureAdminTimerResetControls();
        if (!controls.status) return;
        controls.status.textContent = message;
        controls.status.style.color = isError ? '#fecaca' : '';
        controls.status.style.opacity = isError ? '1' : '0.82';
    }

    function parseAdminTimeValue(value, fallback = 0) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function getAdminTimeAdjustmentControls() {
        return {
            targetInput: document.getElementById('support-admin-time-target'),
            selectedMeta: document.getElementById('support-admin-time-selected'),
            results: document.getElementById('support-admin-time-user-results'),
            scopeSelect: document.getElementById('support-admin-time-scope'),
            hoursInput: document.getElementById('support-admin-time-hours'),
            minutesInput: document.getElementById('support-admin-time-minutes'),
            applyButton: document.getElementById('support-admin-time-apply-btn'),
            removeButton: document.getElementById('support-admin-user-remove-btn')
        };
    }

    function getAdminAdjustmentDateMeta(referenceDate = new Date()) {
        const date = new Date(referenceDate);
        const dayIdx = (date.getDay() + 6) % 7;
        const weekStart = new Date(date);
        weekStart.setHours(0, 0, 0, 0);
        weekStart.setDate(weekStart.getDate() - dayIdx);
        const weekKey = typeof getWeekKey === 'function'
            ? getWeekKey(weekStart)
            : `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;

        return {
            dateKey: date.toLocaleDateString('sv-SE'),
            weekKey,
            dayIdx
        };
    }

    function getAdminTimeAdjustmentReferenceDate(scope = 'today') {
        const normalizedScope = normalizeAdminTimeAdjustmentScope(scope);
        const referenceDate = new Date();

        if (normalizedScope === 'yesterday') {
            referenceDate.setDate(referenceDate.getDate() - 1);
        }

        return referenceDate;
    }

    async function loadAdminTimeAdjustmentUserChoices(forceRefresh = false) {
        if (!forceRefresh && adminTimeAdjustmentUserChoices.length) {
            return adminTimeAdjustmentUserChoices;
        }

        if (!forceRefresh && adminTimeAdjustmentUserChoicesPromise) {
            return adminTimeAdjustmentUserChoicesPromise;
        }

        adminTimeAdjustmentUserChoicesPromise = db.collection('users').get()
            .then(snapshot => {
                adminTimeAdjustmentUserChoices = snapshot.docs
                    .map(doc => {
                        const data = doc.data() || {};
                        const username = String(data.username || '').trim();
                        const name = String(data.name || '').trim();
                        const email = String(data.email || '').trim().toLowerCase();
                        const emailPrefix = email ? email.split('@')[0] : '';
                        const primaryLabel = username || name || emailPrefix || email || doc.id;
                        const searchTokens = [
                            username,
                            name,
                            email,
                            emailPrefix,
                            doc.id
                        ].map(token => normalizeAdminLookupValue(token)).filter(Boolean);

                        return {
                            uid: doc.id,
                            username,
                            name,
                            email,
                            emailPrefix,
                            primaryLabel,
                            preferredInput: email || username || primaryLabel || doc.id,
                            secondaryLabel: [
                                name && name !== primaryLabel ? `Ad: ${name}` : '',
                                email,
                                `UID: ${doc.id.slice(0, 8)}`
                            ].filter(Boolean).join(' | '),
                            searchTokens,
                            searchText: normalizeAdminLookupValue(searchTokens.join(' ')),
                            rawData: data
                        };
                    })
                    .sort((a, b) => a.primaryLabel.localeCompare(b.primaryLabel, 'tr'));

                adminTimeAdjustmentUserChoicesPromise = null;
                return adminTimeAdjustmentUserChoices;
            })
            .catch(error => {
                adminTimeAdjustmentUserChoicesPromise = null;
                throw error;
            });

        return adminTimeAdjustmentUserChoicesPromise;
    }

    function getFilteredAdminTimeAdjustmentUserChoices(userChoices = [], filterValue = '') {
        const normalizedFilter = normalizeAdminLookupValue(filterValue);
        if (!normalizedFilter) {
            return userChoices.slice(0, 12);
        }

        const exactMatches = [];
        const partialMatches = [];

        userChoices.forEach(user => {
            if (user.searchTokens.includes(normalizedFilter)) {
                exactMatches.push(user);
                return;
            }

            if (user.searchText.includes(normalizedFilter)) {
                partialMatches.push(user);
            }
        });

        return [...exactMatches, ...partialMatches].slice(0, 12);
    }

    function clearAdminTimeAdjustmentSelection(options = {}) {
        const controls = getAdminTimeAdjustmentControls();
        const targetInput = controls.targetInput;

        if (targetInput) {
            delete targetInput.dataset.selectedUid;
            delete targetInput.dataset.selectedLabel;
            if (!options.preserveInput) {
                targetInput.value = '';
            }
        }

        if (controls.selectedMeta) {
            controls.selectedMeta.style.display = 'none';
            controls.selectedMeta.innerHTML = '';
        }
    }

    function setAdminTimeAdjustmentSelection(userChoice = null) {
        const controls = getAdminTimeAdjustmentControls();
        if (!controls.targetInput || !userChoice) return;

        controls.targetInput.value = userChoice.preferredInput;
        controls.targetInput.dataset.selectedUid = userChoice.uid;
        controls.targetInput.dataset.selectedLabel = userChoice.preferredInput;

        if (controls.selectedMeta) {
            controls.selectedMeta.style.display = 'block';
            controls.selectedMeta.innerHTML = `
                <div style="font-weight:700; margin-bottom:4px;">Secilen kullanici: ${escapeAdminTimeAdjustmentHtml(userChoice.primaryLabel)}</div>
                <div style="opacity:0.82;">${escapeAdminTimeAdjustmentHtml(userChoice.secondaryLabel || userChoice.uid)}</div>
            `;
        }
    }

    async function renderAdminTimeAdjustmentUserMatches(filterValue = '') {
        const controls = getAdminTimeAdjustmentControls();
        if (!controls.results) return [];

        controls.results.innerHTML = `<div style="padding:10px 12px; border-radius:12px; background:rgba(15,23,42,0.38); font-size:0.88rem; opacity:0.78;">Kullanicilar yukleniyor...</div>`;

        try {
            const userChoices = await loadAdminTimeAdjustmentUserChoices();
            const matches = getFilteredAdminTimeAdjustmentUserChoices(userChoices, filterValue);
            const selectedUid = String(controls.targetInput?.dataset.selectedUid || '');

            if (!matches.length) {
                controls.results.innerHTML = `<div style="padding:10px 12px; border-radius:12px; background:rgba(15,23,42,0.38); font-size:0.88rem; opacity:0.78;">Bu aramayla eslesen kullanici bulunamadi.</div>`;
                return [];
            }

            controls.results.innerHTML = matches.map(user => {
                const isSelected = selectedUid === user.uid;
                return `
                    <button type="button" data-admin-time-user-uid="${escapeAdminTimeAdjustmentHtml(user.uid)}" style="display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:100%; padding:11px 12px; border-radius:12px; border:1px solid ${isSelected ? 'rgba(59,130,246,0.65)' : 'rgba(255,255,255,0.08)'}; background:${isSelected ? 'rgba(37,99,235,0.16)' : 'rgba(15,23,42,0.44)'}; color:var(--header-text); cursor:pointer; text-align:left;">
                        <span style="font-weight:700;">${escapeAdminTimeAdjustmentHtml(user.primaryLabel)}</span>
                        <span style="font-size:0.82rem; opacity:0.78;">${escapeAdminTimeAdjustmentHtml(user.secondaryLabel || user.uid)}</span>
                    </button>
                `;
            }).join('');

            return matches;
        } catch (error) {
            controls.results.innerHTML = `<div style="padding:10px 12px; border-radius:12px; background:rgba(127,29,29,0.28); border:1px solid rgba(248,113,113,0.28); font-size:0.88rem;">Kullanici listesi yuklenemedi. Lutfen tekrar dene.</div>`;
            throw error;
        }
    }

    async function resolveAdminTimeAdjustmentUser(targetValue, selectedUid = '') {
        const normalizedTarget = String(targetValue || '').trim();
        const userChoices = await loadAdminTimeAdjustmentUserChoices();

        if (selectedUid) {
            const selectedChoice = userChoices.find(user => user.uid === selectedUid);
            if (selectedChoice) {
                const selectedDoc = await db.collection('users').doc(selectedChoice.uid).get();
                if (selectedDoc.exists) {
                    return { userDoc: selectedDoc, userChoice: selectedChoice };
                }
            }
        }

        if (!normalizedTarget) {
            throw new Error('target-empty');
        }

        const normalizedLookup = normalizeAdminLookupValue(normalizedTarget);
        const exactMatches = userChoices.filter(user => user.searchTokens.includes(normalizedLookup));

        if (exactMatches.length === 1) {
            const exactDoc = await db.collection('users').doc(exactMatches[0].uid).get();
            if (exactDoc.exists) {
                return { userDoc: exactDoc, userChoice: exactMatches[0] };
            }
        }
        if (exactMatches.length > 1) {
            throw new Error('target-ambiguous');
        }

        const partialMatches = userChoices.filter(user => user.searchText.includes(normalizedLookup));
        if (partialMatches.length === 1) {
            const partialDoc = await db.collection('users').doc(partialMatches[0].uid).get();
            if (partialDoc.exists) {
                return { userDoc: partialDoc, userChoice: partialMatches[0] };
            }
        }
        if (partialMatches.length > 1) {
            throw new Error('target-ambiguous');
        }

        throw new Error('user-not-found');
    }

    async function deleteAdminDocumentRefs(documentRefs = []) {
        const uniqueRefs = [];
        const seenPaths = new Set();

        (documentRefs || []).forEach(ref => {
            const path = String(ref?.path || '');
            if (!path || seenPaths.has(path)) return;
            seenPaths.add(path);
            uniqueRefs.push(ref);
        });

        const chunkSize = 350;
        for (let index = 0; index < uniqueRefs.length; index += chunkSize) {
            const batch = db.batch();
            uniqueRefs.slice(index, index + chunkSize).forEach(ref => batch.delete(ref));
            await batch.commit();
        }
    }

    async function collectAdminUserSupportMessageRefs(uid = '') {
        const normalizedUid = String(uid || '').trim();
        if (!normalizedUid) return [];

        const refsByPath = new Map();
        const senderSnapshot = await db.collection(SUPPORT_COLLECTION).where('senderId', '==', normalizedUid).get().catch(() => null);
        const ownerSnapshot = await db.collection(SUPPORT_COLLECTION).where('ownerDocId', '==', normalizedUid).get().catch(() => null);

        [senderSnapshot, ownerSnapshot].forEach(snapshot => {
            (snapshot?.docs || []).forEach(doc => {
                refsByPath.set(doc.ref.path, doc.ref);
            });
        });

        return [...refsByPath.values()];
    }

    async function removeAdminUserRecordByTarget(targetValue, selectedUid = '') {
        if (!currentUser || !isCurrentAdmin()) {
            showAlert("Bu islem sadece admin hesabi icin aciktir.");
            return false;
        }

        const controls = getAdminTimeAdjustmentControls();
        const removeButton = controls.removeButton;
        const originalLabel = removeButton ? removeButton.innerHTML : "";

        if (removeButton) {
            removeButton.disabled = true;
            removeButton.style.opacity = '0.72';
            removeButton.style.cursor = 'wait';
            removeButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Kayit kaldiriliyor...</span>';
        }

        setAdminTimerResetStatus('Kullanici kaydi kaldiriliyor...');

        try {
            const { userDoc, userChoice } = await resolveAdminTimeAdjustmentUser(targetValue, selectedUid);
            if (userDoc.id === currentUser.uid) {
                throw new Error('cannot-remove-self');
            }

            const supportRefs = await collectAdminUserSupportMessageRefs(userDoc.id);
            const refsToDelete = [
                userDoc.ref,
                db.collection('publicProfiles').doc(userDoc.id),
                db.collection('leaderboard').doc(userDoc.id),
                ...supportRefs
            ];

            await deleteAdminDocumentRefs(refsToDelete);

            adminTimeAdjustmentUserChoices = adminTimeAdjustmentUserChoices.filter(user => user.uid !== userDoc.id);
            clearAdminTimeAdjustmentSelection();
            if (controls.results) {
                await renderAdminTimeAdjustmentUserMatches('');
            }
            if (typeof loadSupportMessages === 'function') {
                loadSupportMessages().catch(error => {
                    console.error('Destek listesi silme sonrasi yenilenemedi:', error);
                });
            }
            if (typeof refreshLeaderboardOptimistically === 'function') refreshLeaderboardOptimistically(null);
            if (typeof renderLiveLeaderboardFromDocs === 'function') renderLiveLeaderboardFromDocs();

            const removedLabel = String(userChoice?.primaryLabel || userDoc.data()?.username || userDoc.data()?.email || userDoc.id);
            setAdminTimerResetStatus(`${removedLabel} kaydi kaldirildi.`);
            showAlert(`${removedLabel} kaydi kaldirildi.`, 'success');
            return true;
        } catch (error) {
            console.error('Admin kullanici kaldirma basarisiz:', error);
            const errorMessage = String(error?.message || '');
            if (errorMessage === 'cannot-remove-self') {
                setAdminTimerResetStatus('Kendi hesabini bu aracla kaldiramazsin.', true);
                showAlert('Kendi hesabini kaldiramazsin.');
            } else if (errorMessage === 'user-not-found') {
                setAdminTimerResetStatus('Bu kullanici bulunamadi. Lutfen listeden sec.', true);
                showAlert('Kullanici bulunamadi.');
            } else if (errorMessage === 'target-ambiguous') {
                setAdminTimerResetStatus('Birden fazla eslesme bulundu. Lutfen listeden tek bir kullanici sec.', true);
                showAlert('Birden fazla kullanici bulundu.');
            } else {
                setAdminTimerResetStatus('Kullanici kaydi kaldirilirken bir hata olustu. Lutfen tekrar dene.', true);
                showAlert('Kullanici kaldirilamadi.');
            }
            return false;
        } finally {
            if (removeButton) {
                removeButton.disabled = false;
                removeButton.style.opacity = '1';
                removeButton.style.cursor = 'pointer';
                removeButton.innerHTML = originalLabel;
            }
        }
    }

    function buildAdjustedWorkedSchedule(existingSchedule = {}, targetSeconds = 0, scope = 'today', referenceDate = new Date()) {
        const currentMeta = getAdminAdjustmentDateMeta(referenceDate);
        const normalizedScope = normalizeAdminTimeAdjustmentScope(scope);
        const nextSchedule = cloneAdminScheduleData(existingSchedule || {});
        const safeTargetSeconds = Math.max(0, parseAdminTimeValue(targetSeconds, 0));

        if (normalizedScope === 'today' || normalizedScope === 'yesterday') {
            ensureAdminScheduleDay(nextSchedule, currentMeta.weekKey, currentMeta.dayIdx).workedSeconds = safeTargetSeconds;
        } else if (normalizedScope === 'week') {
            const weekEntries = collectAdminScheduleEntries(nextSchedule, entry => entry.weekKey === currentMeta.weekKey);
            redistributeWorkedSecondsAcrossEntries(nextSchedule, weekEntries, safeTargetSeconds, currentMeta);
        } else {
            const allEntries = collectAdminScheduleEntries(nextSchedule);
            redistributeWorkedSecondsAcrossEntries(nextSchedule, allEntries, safeTargetSeconds, currentMeta);
        }

        return {
            nextSchedule,
            currentMeta,
            normalizedScope,
            appliedTargetDaySeconds: getAdminScheduleDayWorkedSeconds(nextSchedule, currentMeta.weekKey, currentMeta.dayIdx),
            appliedTargetWeekSeconds: getAdminScheduleWeekWorkedSeconds(nextSchedule, currentMeta.weekKey),
            appliedTotalSeconds: getWorkedSecondsTotal(nextSchedule)
        };
    }

    function buildAdminTimeAdjustmentPatches(uid, userData = {}, targetSeconds = 0, scope = 'today', referenceDate = new Date()) {
        const normalizedSeconds = Math.max(0, targetSeconds);
        const adjustmentRequestedAt = new Date().toISOString();
        const adjustmentRequestedAtMs = Date.now();
        const scheduleUpdate = buildAdjustedWorkedSchedule(userData.schedule || {}, normalizedSeconds, scope, referenceDate);
        const nextSchedule = scheduleUpdate.nextSchedule;
        const preservedSchedule = cloneAdminScheduleData(userData.schedule || {});
        const targetMeta = scheduleUpdate.currentMeta;
        const currentMeta = getAdminAdjustmentDateMeta(new Date());
        const isWeeklyAdjustment = scheduleUpdate.normalizedScope === 'week';
        const effectiveSchedule = isWeeklyAdjustment ? preservedSchedule : nextSchedule;
        const preservedDaySeconds = getAdminScheduleDayWorkedSeconds(preservedSchedule, currentMeta.weekKey, currentMeta.dayIdx);
        const preservedTotalWorkedSeconds = Math.max(
            0,
            parseAdminTimeValue(userData.totalWorkedSeconds, 0),
            parseAdminTimeValue(userData.totalStudyTime, 0),
            getWorkedSecondsTotal(preservedSchedule)
        );
        const totalWorkedSeconds = isWeeklyAdjustment
            ? preservedTotalWorkedSeconds
            : scheduleUpdate.appliedTotalSeconds;
        const dailyStudyTime = isWeeklyAdjustment
            ? preservedDaySeconds
            : getAdminScheduleDayWorkedSeconds(nextSchedule, currentMeta.weekKey, currentMeta.dayIdx);
        const weeklyStudyTime = isWeeklyAdjustment
            ? normalizedSeconds
            : getAdminScheduleWeekWorkedSeconds(nextSchedule, currentMeta.weekKey);
        const totalQuestionsAllTime = typeof calculateTotalQuestionsFromSchedule === 'function'
            ? calculateTotalQuestionsFromSchedule(effectiveSchedule)
            : Math.max(0, parseAdminTimeValue(userData.totalQuestionsAllTime, 0));
        const dailyQuestions = typeof getCurrentDayQuestionsFromSchedule === 'function'
            ? getCurrentDayQuestionsFromSchedule(effectiveSchedule, new Date())
            : Math.max(0, parseAdminTimeValue(userData.dailyQuestionCount, 0));
        const weeklyQuestions = typeof getCurrentWeekQuestionsFromSchedule === 'function'
            ? getCurrentWeekQuestionsFromSchedule(effectiveSchedule, new Date())
            : Math.max(dailyQuestions, parseAdminTimeValue(userData.weeklyQuestionCount, 0));
        const nowMs = Date.now();
        const identityPatch = {
            username: userData.username || '',
            email: userData.email || '',
            about: userData.about || '',
            profileImage: userData.profileImage || '',
            accountCreatedAt: userData.accountCreatedAt || '',
            studyTrack: userData.studyTrack || '',
            selectedSubjects: Array.isArray(userData.selectedSubjects) ? userData.selectedSubjects : [],
            selectedTitleId: userData.selectedTitleId || '',
            titleAwards: userData.titleAwards || {},
            role: userData.role || (userData.isAdmin ? 'admin' : 'user'),
            isAdmin: !!userData.isAdmin,
            adminTitle: userData.adminTitle || ''
        };
        const sharedPatch = {
            uid,
            name: userData.name || userData.username || '',
            totalWorkedSeconds,
            totalStudyTime: totalWorkedSeconds,
            totalTime: Math.max(0, totalWorkedSeconds) * 1000,
            totalQuestionsAllTime,
            dailyStudyTime,
            todayStudyTime: dailyStudyTime,
            todayWorkedSeconds: dailyStudyTime,
            dailyStudyDateKey: currentMeta.dateKey,
            todayDateKey: currentMeta.dateKey,
            weeklyStudyTime,
            currentWeekSeconds: weeklyStudyTime,
            currentSessionTime: 0,
            activeTimer: null,
            legacyWorkingStartedAt: 0,
            isWorking: false,
            isRunning: false,
            lastSyncTime: nowMs,
            lastTimerSyncAt: nowMs,
            updatedAtMs: nowMs,
            adminTimeAdjustment: {
                token: `adjust_${adjustmentRequestedAtMs}`,
                scope: scheduleUpdate.normalizedScope,
                dateKey: targetMeta.dateKey,
                weekKey: targetMeta.weekKey,
                requestedAt: adjustmentRequestedAt,
                requestedAtMs: adjustmentRequestedAtMs,
                targetSeconds: normalizedSeconds,
                appliedDaySeconds: dailyStudyTime,
                appliedWeekSeconds: weeklyStudyTime
            },
            dailyQuestionCount: dailyQuestions,
            weeklyQuestionCount: weeklyQuestions,
            dailyQuestions,
            weeklyQuestions,
            daily: dailyQuestions,
            weekly: weeklyQuestions,
            total: totalQuestionsAllTime
        };

        return {
            usersPatch: {
                ...identityPatch,
                ...sharedPatch,
                schedule: effectiveSchedule
            },
            publicProfilePatch: {
                ...identityPatch,
                ...sharedPatch
            },
            leaderboardPatch: {
                ...identityPatch,
                ...sharedPatch,
                schedule: effectiveSchedule
            }
        };
    }

    function normalizeAdminLookupValue(value) {
        return String(value || '')
            .trim()
            .toLocaleLowerCase('tr-TR')
            .normalize('NFKC');
    }

    async function applyAdminTimeAdjustmentByTarget(targetValue, targetSeconds, scope = 'today', selectedUid = '') {
        if (!currentUser || !isCurrentAdmin()) {
            showAlert("Bu islem sadece admin hesabi icin aciktir.");
            return false;
        }

        const normalizedTarget = String(targetValue || '').trim();
        const normalizedScope = normalizeAdminTimeAdjustmentScope(scope);
        const scopeLabel = getAdminTimeAdjustmentScopeLabel(normalizedScope);

        if (!normalizedTarget && !selectedUid) {
            setAdminTimerResetStatus("Lutfen listeden bir kullanici sec veya arama yaz.", true);
            showAlert("Kullanici hedefi gerekli.");
            return false;
        }

        const safeSeconds = Math.max(0, parseAdminTimeValue(targetSeconds, 0));
        const controls = getAdminTimeAdjustmentControls();
        const applyButton = controls.applyButton;
        const originalLabel = applyButton ? applyButton.innerHTML : "";

        if (applyButton) {
            applyButton.disabled = true;
            applyButton.style.opacity = '0.72';
            applyButton.style.cursor = 'wait';
            applyButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Sure guncelleniyor...</span>';
        }

        setAdminTimerResetStatus(`${scopeLabel} suresi guncelleniyor...`);

        try {
            const { userDoc, userChoice } = await resolveAdminTimeAdjustmentUser(normalizedTarget, selectedUid);
            const userData = userDoc.data() || {};
            const adjustmentReferenceDate = getAdminTimeAdjustmentReferenceDate(normalizedScope);
            const patches = buildAdminTimeAdjustmentPatches(userDoc.id, userData, safeSeconds, normalizedScope, adjustmentReferenceDate);

            if (currentUser.uid === userDoc.id && typeof pauseRealtimeTimer === 'function') {
                try {
                    await pauseRealtimeTimer({ silentWriteFailure: true });
                } catch (pauseError) {
                    console.warn('Admin sure araci timer durduramadi:', pauseError);
                }
            }

            const batch = db.batch();
            batch.set(userDoc.ref, patches.usersPatch, { merge: true });
            await batch.commit();

            if (currentUser.uid === userDoc.id) {
                if (typeof globalThis.currentUserLiveDoc !== 'undefined') {
                    globalThis.currentUserLiveDoc = {
                        ...(globalThis.currentUserLiveDoc || {}),
                        ...(userData || {}),
                        ...patches.usersPatch
                    };
                }
                if (typeof globalThis.scheduleData !== 'undefined') {
                    globalThis.scheduleData = patches.usersPatch.schedule || {};
                }
                if (typeof globalThis.totalWorkedSecondsAllTime !== 'undefined') {
                    globalThis.totalWorkedSecondsAllTime = patches.usersPatch.totalWorkedSeconds || 0;
                }
                try {
                    localStorage.removeItem('codexRealtimeTimerStateV1');
                    localStorage.removeItem('codexRealtimeTimerRecoveryV1');
                } catch (storageError) {
                    console.warn('Admin sure araci local timer kaydini silemedi:', storageError);
                }
                if (typeof refreshCurrentTotals === 'function') refreshCurrentTotals();
                if (typeof renderSchedule === 'function') renderSchedule();
                if (typeof updateLiveStudyPreview === 'function') updateLiveStudyPreview();
                if (typeof refreshLeaderboardOptimistically === 'function') refreshLeaderboardOptimistically(null);
                if (typeof renderLiveLeaderboardFromDocs === 'function') renderLiveLeaderboardFromDocs();
            }

            const resolvedLabel = String(userChoice?.primaryLabel || userData.username || userData.email || normalizedTarget || userDoc.id);
            setAdminTimerResetStatus(`${resolvedLabel} icin ${scopeLabel.toLocaleLowerCase('tr-TR')} sure ${formatAdminAdjustmentDuration(safeSeconds)} olarak guncellendi.`);
            showAlert(`${resolvedLabel} ${scopeLabel.toLocaleLowerCase('tr-TR')} suresi guncellendi.`, 'success');
            return true;
        } catch (error) {
            console.error('Admin sure duzeltme basarisiz:', error);
            const errorMessage = String(error?.message || '');
            if (errorMessage === 'user-not-found') {
                setAdminTimerResetStatus("Bu kullanici bulunamadi. Lutfen listeden sec.", true);
                showAlert("Kullanici bulunamadi.");
            } else if (errorMessage === 'target-ambiguous') {
                setAdminTimerResetStatus("Birden fazla eslesme bulundu. Lutfen listeden tek bir kullanici sec.", true);
                showAlert("Birden fazla kullanici bulundu.");
            } else if (errorMessage === 'target-empty') {
                setAdminTimerResetStatus("Lutfen listeden bir kullanici sec veya arama yaz.", true);
                showAlert("Kullanici hedefi gerekli.");
            } else {
                setAdminTimerResetStatus("Sure duzeltilirken bir hata olustu. Lutfen tekrar dene.", true);
                showAlert("Sure duzeltilemedi.");
            }
            return false;
        } finally {
            if (applyButton) {
                applyButton.disabled = false;
                applyButton.style.opacity = '1';
                applyButton.style.cursor = 'pointer';
                applyButton.innerHTML = originalLabel;
            }
        }
    }

    async function applyAdminTimeAdjustmentFromControls() {
        const controls = getAdminTimeAdjustmentControls();
        const targetValue = controls.targetInput?.value || '';
        const selectedUid = String(controls.targetInput?.dataset.selectedUid || '');
        const scope = normalizeAdminTimeAdjustmentScope(controls.scopeSelect?.value || 'today');
        const hours = Math.max(0, parseAdminTimeValue(controls.hoursInput?.value, 0));
        const minutes = Math.max(0, Math.min(59, parseAdminTimeValue(controls.minutesInput?.value, 0)));
        await applyAdminTimeAdjustmentByTarget(targetValue, (hours * 3600) + (minutes * 60), scope, selectedUid);
    }

    async function removeAdminUserRecordFromControls() {
        const controls = getAdminTimeAdjustmentControls();
        const targetValue = controls.targetInput?.value || '';
        const selectedUid = String(controls.targetInput?.dataset.selectedUid || '');
        await removeAdminUserRecordByTarget(targetValue, selectedUid);
    }

    async function upsertSupportMessageInUserDoc(message) {
        const ownerDocId = message.ownerDocId || message.senderId || currentUser?.uid || "";
        if (!ownerDocId) throw new Error("owner-doc-missing");

        const ownerContext = await readOwnerSupportContext(ownerDocId, message.senderUsername || currentUsername || "Kullanici");
        const normalizedMessage = normalizeSupportRecord(
            { ...message, ownerDocId },
            {
                ownerDocId,
                defaultUsername: ownerContext.ownerData.username || message.senderUsername || currentUsername || "Kullanici",
                hasUserDoc: true
            }
        );

        const nextMessages = ownerContext.messages.some(item => item.id === normalizedMessage.id)
            ? ownerContext.messages.map(item => item.id === normalizedMessage.id ? mergeSupportRecords(item, normalizedMessage) : item)
            : [normalizedMessage, ...ownerContext.messages];

        await ownerContext.ownerRef.set({ supportMessages: nextMessages.map(serializeSupportMessageForUserDoc) }, { merge: true });
        return true;
    }

    async function upsertSupportMessageInCollection(message) {
        const normalizedMessage = normalizeSupportRecord(message, {
            fallbackId: message.collectionDocId || message.id || createSupportMessageId(),
            ownerDocId: message.ownerDocId || message.senderId || currentUser?.uid || "",
            defaultUsername: message.senderUsername || currentUsername || "Kullanici",
            hasCollection: true
        });
        const collectionDocId = normalizedMessage.collectionDocId || normalizedMessage.id;
        normalizedMessage.collectionDocId = collectionDocId;

        await db.collection(SUPPORT_COLLECTION).doc(collectionDocId).set(
            serializeSupportMessageForCollection(normalizedMessage),
            { merge: true }
        );

        return collectionDocId;
    }

    async function persistSupportMessage(message, options = { writeUserDoc: true, writeCollection: true }) {
        const normalizedMessage = normalizeSupportRecord(
            { ...message, updatedAt: message.updatedAt || new Date().toISOString() },
            {
                ownerDocId: message.ownerDocId || message.senderId || currentUser?.uid || "",
                defaultUsername: message.senderUsername || currentUsername || "Kullanici",
                hasUserDoc: !!message.hasUserDoc,
                hasCollection: !!message.hasCollection,
                collectionDocId: message.collectionDocId || ""
            }
        );

        const results = [];

        if (options.writeUserDoc !== false && normalizedMessage.ownerDocId) {
            results.push(await attemptSupportWrite("Kullanici destek kaydi yazilamadi:", () => upsertSupportMessageInUserDoc(normalizedMessage)));
        }

        if (options.writeCollection !== false) {
            const collectionResult = await attemptSupportWrite("Destek koleksiyon kaydi yazilamadi:", () => upsertSupportMessageInCollection(normalizedMessage));
            results.push(collectionResult);
            if (collectionResult.ok && collectionResult.value) {
                normalizedMessage.collectionDocId = collectionResult.value;
            }
        }

        if (!results.length || !results.some(result => result.ok)) {
            throw (results.find(result => !result.ok)?.error || new Error("support-write-failed"));
        }

        return normalizedMessage;
    }

    function buildSupportPatch(message, patch = {}) {
        return normalizeSupportRecord(
            {
                ...message,
                ...patch,
                updatedAt: new Date().toISOString()
            },
            {
                ownerDocId: message.ownerDocId || message.senderId || currentUser?.uid || "",
                defaultUsername: message.senderUsername || currentUsername || "Kullanici",
                hasUserDoc: !!message.hasUserDoc,
                hasCollection: !!message.hasCollection,
                collectionDocId: message.collectionDocId || ""
            }
        );
    }

    updateSupportButton = function() {
        const button = document.getElementById('support-btn');
        const label = document.getElementById('support-btn-text');
        if (!button || !label) return;

        if (isCurrentAdmin()) {
            const unreadCount = supportMessagesCache.filter(item => !item.read).length;
            button.classList.add('admin-mode');
            label.innerText = unreadCount ? `Admin Destek (${unreadCount})` : 'Admin Destek';
            return;
        }

        const ownCount = currentUser ? supportMessagesCache.length : 0;
        button.classList.remove('admin-mode');
        label.innerText = ownCount ? `Destek (${ownCount})` : 'Destek';
    };

    updateAdminUI = function() {
        const isAdmin = isCurrentAdmin();
        const button = document.getElementById('support-btn');
        const label = document.getElementById('support-btn-text');
        const userComposer = document.getElementById('support-user-composer');
        const adminSummary = document.getElementById('support-admin-summary');
        const modalTitle = document.getElementById('support-modal-title');
        const modalSubtitle = document.getElementById('support-modal-subtitle');
        const listTitle = document.getElementById('support-list-title');
        const listHint = document.getElementById('support-list-hint');
        const secondaryMeta = document.getElementById('support-meta-secondary');

        button?.classList.toggle('admin-mode', isAdmin);
        if (label) label.innerText = isAdmin ? 'Admin Destek' : 'Destek';
        if (userComposer) userComposer.style.display = isAdmin ? 'none' : 'block';
        if (adminSummary) adminSummary.style.display = isAdmin ? 'block' : 'none';
        if (modalTitle) modalTitle.innerText = isAdmin ? 'Admin Destek Paneli' : 'Yardim ve Destek';
        if (modalSubtitle) {
            modalSubtitle.innerText = isAdmin
                ? 'Mesajlari oku, cevapla, okundu durumunu duzenle veya herkesten gizle.'
                : 'Mesajlar sadece sen ve admin arasinda kalir. Istersen gecmisinden silebilirsin.';
        }
        if (listTitle) listTitle.innerText = isAdmin ? 'Tum Gelen Mesajlar' : 'Destek Gecmisi';
        if (listHint) {
            listHint.innerText = isAdmin
                ? 'Sistem hem kullanici kayitlarini hem de destek koleksiyonunu senkron takip eder.'
                : 'Gonderdigin mesajlar ve admin yanitlari burada otomatik guncellenir.';
        }
        if (secondaryMeta) {
            secondaryMeta.innerText = isAdmin
                ? 'Mesajlar sadece admin ve ilgili kullanici tarafinda gorunur'
                : 'Mesajlar sadece sen ve admin tarafinda gorunur';
        }

        const adminResetControls = ensureAdminTimerResetControls();
        if (adminResetControls.panel) {
            adminResetControls.panel.style.display = isAdmin ? 'flex' : 'none';
            if (isAdmin) {
                const targetValue = document.getElementById('support-admin-time-target')?.value || '';
                renderAdminTimeAdjustmentUserMatches(targetValue).catch(error => {
                    console.error('Admin kullanici listesi guncellenemedi:', error);
                });
            }
        }

        updateSupportButton();
    };

    loadSupportMessages = async function() {
        if (!currentUser) {
            supportMessagesCache = [];
            updateAdminUI();
            renderSupportModal();
            return;
        }

        const [userDocMessages, collectionMessages] = await Promise.all([
            loadUserDocSupportMessagesForCurrentContext(),
            loadCollectionSupportMessagesForCurrentContext()
        ]);

        const isAdminView = isCurrentAdmin();
        supportMessagesCache = combineSupportRecords([...userDocMessages, ...collectionMessages])
            .filter(item => isSupportMessageVisible(item, isAdminView));

        updateSupportButton();
        renderSupportModal();
    };

    renderSupportModal = function() {
        const list = document.getElementById('support-messages-list');
        const primaryMeta = document.getElementById('support-meta-primary');
        const secondaryMeta = document.getElementById('support-meta-secondary');
        const totalStat = document.getElementById('support-admin-total');
        const unreadStat = document.getElementById('support-admin-unread');
        const repliedStat = document.getElementById('support-admin-public');
        if (!list || !primaryMeta || !secondaryMeta || !totalStat || !unreadStat || !repliedStat) return;

        const isAdminView = isCurrentAdmin();
        const visibleMessages = [...supportMessagesCache].sort((a, b) => getSupportVersion(b) - getSupportVersion(a));
        const unreadCount = visibleMessages.filter(item => !item.read).length;
        const repliedCount = visibleMessages.filter(item => item.adminReply).length;

        primaryMeta.innerText = isAdminView
            ? `${visibleMessages.length} mesaj`
            : `${visibleMessages.length} kayit`;
        secondaryMeta.innerText = isAdminView
            ? `${unreadCount} yeni mesaj`
            : 'Sildigin kayitlar bu listeden kaldirilir';
        totalStat.innerText = visibleMessages.length;
        unreadStat.innerText = unreadCount;
        repliedStat.innerText = repliedCount;

        if (!visibleMessages.length) {
            list.innerHTML = `<div class="support-empty">${isAdminView ? 'Henuz destek mesaji gelmedi.' : 'Henuz destek mesaji yok. Ilk mesaji gonderebilirsin.'}</div>`;
            updateSupportButton();
            return;
        }

        list.innerHTML = visibleMessages.map(item => {
            const senderLabel = isAdminView ? escapeUserNoteHtml(item.senderUsername || "Kullanici") : 'Sen';
            const replyBlock = item.adminReply
                ? `
                    <div class="support-reply-block">
                        <div class="support-reply-label"><i class="fas fa-reply"></i> Admin Yaniti</div>
                        <div class="support-reply-text">${formatUserNoteHtml(item.adminReply)}</div>
                        <div class="support-card-meta" style="margin-top: 8px;">
                            ${item.repliedAt ? `Yanit: ${formatUserNoteDate(item.repliedAt)}` : ''}
                            ${item.repliedBy ? ` · ${escapeUserNoteHtml(item.repliedBy)}` : ''}
                        </div>
                    </div>
                `
                : '';

            const deleteButton = `
                <button type="button" onclick="deleteSupportMessage('${item.id}')" style="background-color: var(--pomodoro-accent); color: var(--header-text);">
                    <i class="fas fa-trash"></i> Sil
                </button>
            `;

            const adminControls = isAdminView
                ? `
                    <div class="support-card-actions">
                        <button type="button" onclick="toggleSupportMessageRead('${item.id}')" style="background-color: var(--button-bg); color: var(--header-text);">
                            <i class="fas ${item.read ? 'fa-envelope-open-text' : 'fa-envelope'}"></i> ${item.read ? 'Okunmamis Yap' : 'Okundu Yap'}
                        </button>
                        <button type="button" onclick="saveSupportReply('${item.id}')" style="background-color: var(--accent-color); color: var(--header-text);">
                            <i class="fas fa-paper-plane"></i> Yaniti Kaydet
                        </button>
                        ${deleteButton}
                    </div>
                    <div class="support-reply-box">
                        <textarea id="support-reply-${item.id}" rows="4" placeholder="Bu mesaja admin yaniti yaz...">${escapeUserNoteHtml(item.adminReply || "")}</textarea>
                    </div>
                `
                : `
                    <div class="support-card-actions">
                        ${deleteButton}
                    </div>
                `;

            return `
                <article class="support-message-card private ${item.read ? '' : 'unread'}">
                    <div class="support-card-top">
                        <div>
                            <div class="support-card-title">
                                <span>${senderLabel}</span>
                            </div>
                            <div class="support-card-meta">${formatUserNoteDate(item.timestamp)}</div>
                        </div>
                        <div class="support-pill-row">
                            <span class="support-pill private"><i class="fas fa-lock"></i> Ozel</span>
                            ${isAdminView ? `<span class="support-pill ${item.read ? '' : 'unread'}"><i class="fas ${item.read ? 'fa-check' : 'fa-bell'}"></i> ${item.read ? 'Okundu' : 'Yeni'}</span>` : ''}
                        </div>
                    </div>
                    <div class="support-message-body">${formatUserNoteHtml(item.message)}</div>
                    ${replyBlock}
                    ${adminControls}
                </article>
            `;
        }).join('');

        updateSupportButton();
    };

    resetAllUsersTimersForToday = async function() {
        if (!currentUser || !isCurrentAdmin()) {
            showAlert("Bu islem sadece admin hesabi icin aciktir.");
            return;
        }

        const controls = ensureAdminTimerResetControls();
        const resetButton = controls.button;
        const originalButtonHtml = resetButton ? resetButton.innerHTML : "";
        const resetMeta = getTodayTimerResetMeta();

        if (!confirm("Diger tum kullanicilarin bugune ait calisma suresi sifirlansin mi? Acik pomodoro ve kronometreler de durdurulacak.")) {
            return;
        }

        if (resetButton) {
            resetButton.disabled = true;
            resetButton.style.opacity = '0.72';
            resetButton.style.cursor = 'wait';
            resetButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Sureler sifirlaniyor...</span>';
        }
        setAdminTimerResetStatus("Kullanicilar guncelleniyor. Bu islem acik timerlari da kapatir.");

        try {
            const usersSnapshot = await db.collection('users').get();
            const resetMarker = createAdminTimerResetMarker(resetMeta);
            const patches = [];

            usersSnapshot.docs.forEach(doc => {
                const userData = doc.data() || {};
                const adminDoc = !!userData.isAdmin || isAdminIdentity(userData.username || "", userData.email || "");
                if (doc.id === currentUser.uid || adminDoc) return;

                patches.push({
                    ref: doc.ref,
                    patch: buildTodayTimerResetPatch(userData, resetMeta, resetMarker)
                });
            });

            await commitTimerResetPatches(patches);

            setAdminTimerResetStatus(
                patches.length
                    ? `${patches.length} kullanicinin bugunku suresi sifirlandi.`
                    : "Sifirlanacak baska kullanici bulunamadi."
            );
            showAlert(
                patches.length
                    ? `${patches.length} kullanicinin bugunku calisma suresi sifirlandi.`
                    : "Sifirlanacak baska kullanici bulunamadi.",
                "success"
            );
        } catch (error) {
            console.error("Admin bugunluk timer sifirlama basarisiz:", error);
            setAdminTimerResetStatus("Sifirlama sirasinda bir hata olustu. Lutfen tekrar dene.", true);
            showAlert("Bugunku sureler sifirlanamadi.");
        } finally {
            if (resetButton) {
                resetButton.disabled = false;
                resetButton.style.opacity = '1';
                resetButton.style.cursor = 'pointer';
                resetButton.innerHTML = originalButtonHtml;
            }
        }
    };

    submitSupportMessage = async function() {
        if (!currentUser) {
            showAlert("Mesaj gondermek icin giris yapmalisin.");
            return;
        }

        const submitButton = document.getElementById('support-submit-btn');
        const messageInput = document.getElementById('support-message-input');
        const message = messageInput?.value.trim() || "";

        if (message.length < 5) {
            showAlert("Destek mesaji en az 5 karakter olmali.");
            return;
        }

        if (submitButton) submitButton.disabled = true;

        try {
            const adminId = await resolveAdminUserUid();
            await persistSupportMessage({
                id: createSupportMessageId(),
                ownerDocId: currentUser.uid,
                senderId: currentUser.uid,
                senderUsername: currentUsername || "Kullanici",
                message,
                timestamp: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                read: false,
                adminId: adminId || adminUserUid || "",
                visibility: 'private',
                adminReply: "",
                repliedAt: "",
                repliedBy: "",
                deletedForOwner: false,
                deletedForAdmin: false,
                deletedForEveryone: false,
                deletedAt: ""
            });

            if (messageInput) messageInput.value = "";
            await loadSupportMessages();
            showAlert("Mesaj admin hesaba gonderildi.", "success");
        } catch (error) {
            console.error("Destek mesaji gonderilemedi:", error);
            showAlert("Mesaj gonderilemedi. Lutfen tekrar dene.");
        } finally {
            if (submitButton) submitButton.disabled = false;
        }
    };

    deleteSupportMessage = async function(messageId) {
        const message = supportMessagesCache.find(item => item.id === messageId);
        if (!message) return;

        const canDelete = isCurrentAdmin() || message.senderId === currentUser?.uid;
        if (!canDelete) return;
        if (!confirm("Bu destek mesajini silmek istiyor musun?")) return;

        try {
            const nextState = isCurrentAdmin()
                ? buildSupportPatch(message, {
                    deletedForEveryone: true,
                    deletedForAdmin: true,
                    deletedForOwner: true,
                    deletedAt: new Date().toISOString()
                })
                : buildSupportPatch(message, {
                    deletedForOwner: true,
                    deletedAt: new Date().toISOString()
                });

            await persistSupportMessage(nextState, { writeUserDoc: true, writeCollection: true });
            await loadSupportMessages();
            showAlert("Mesaj silindi.", "success");
        } catch (error) {
            console.error("Mesaj silinemedi:", error);
            showAlert("Mesaj silinemedi.");
        }
    };

    toggleSupportMessageRead = async function(messageId) {
        const message = supportMessagesCache.find(item => item.id === messageId);
        if (!message || !isCurrentAdmin()) return;

        try {
            await persistSupportMessage(
                buildSupportPatch(message, { read: !message.read }),
                { writeUserDoc: true, writeCollection: true }
            );
            await loadSupportMessages();
        } catch (error) {
            console.error("Mesaj durumu guncellenemedi:", error);
            showAlert("Okunma durumu guncellenemedi.");
        }
    };

    saveSupportReply = async function(messageId) {
        const message = supportMessagesCache.find(item => item.id === messageId);
        if (!message || !isCurrentAdmin()) return;

        const replyField = document.getElementById(`support-reply-${messageId}`);
        const replyValue = replyField?.value.trim() || "";
        if (replyValue.length < 2) {
            showAlert("Admin yaniti en az 2 karakter olmali.");
            return;
        }

        try {
            await persistSupportMessage(
                buildSupportPatch(message, {
                    adminReply: replyValue,
                    repliedAt: new Date().toISOString(),
                    repliedBy: currentUsername || ADMIN_USERNAME,
                    read: true,
                    adminId: currentUser?.uid || adminUserUid || ""
                }),
                { writeUserDoc: true, writeCollection: true }
            );
            await loadSupportMessages();
            showAlert("Yanit kullaniciya kaydedildi.", "success");
        } catch (error) {
            console.error("Admin yaniti kaydedilemedi:", error);
            showAlert("Yanit kaydedilemedi.");
        }
    };

    openSupportModal = async function() {
        if (!currentUser) {
            showAlert("Destek paneli icin giris yapmalisin.");
            return;
        }

        document.getElementById('support-modal').style.display = 'flex';
        updateAdminUI();
        await loadSupportMessages();
        syncBodyModalLock();
    };

    closeSupportModal = function() {
        document.getElementById('support-modal').style.display = 'none';
        syncBodyModalLock();
    };

    window.addEventListener('load', () => {
        updateAdminUI();
    });

    auth.onAuthStateChanged(user => {
        if (!user) {
            supportMessagesCache = [];
            updateAdminUI();
            renderSupportModal();
            return;
        }

        setTimeout(() => {
            updateAdminUI();
            loadSupportMessages().catch(error => console.error("Destek yeniden yuklenemedi:", error));
        }, 450);
    });
})();
