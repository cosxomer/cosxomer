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

        return { panel, button, status };
    }

    function setAdminTimerResetStatus(message, isError = false) {
        const controls = ensureAdminTimerResetControls();
        if (!controls.status) return;
        controls.status.textContent = message;
        controls.status.style.color = isError ? '#fecaca' : '';
        controls.status.style.opacity = isError ? '1' : '0.82';
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
