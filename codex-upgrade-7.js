(() => {
    const VERIFY_MESSAGE = "Lutfen e-posta adresini kontrol et. Dogrulama baglantisi gonderildi; spam/junk klasorunu da kontrol et.";
    const RESET_PASSWORD_MESSAGE = "Sifre sifirlama baglantisi e-posta adresine gonderildi. Spam/junk klasorunu da kontrol et.";
    const VERIFY_COOLDOWN_MS = 30000;
    const TIMER_SYNC_MS = 10 * 60 * 1000;
    const TIMER_OWNER_TTL_MS = 15000;
    const TIMER_AUTO_STOP_MS = 3 * 60 * 60 * 1000;
    const TITLE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
    const REMOTE_TIMER_STALE_MS = Math.max(TIMER_SYNC_MS + (2 * 60 * 1000), 12 * 60 * 1000);
    const USER_SAVE_DEBOUNCE_MS = 180;
    const TIMER_ACTION_TIMEOUT_MS = 3500;
    const TIMER_OWNER_KEY = "codexTimerOwnerV1";
    const TIMER_OWNER_AT_KEY = "codexTimerOwnerAtV1";
    const TIMER_STORAGE_KEY = "codexRealtimeTimerStateV1";
    const TIMER_RECOVERY_KEY = "codexRealtimeTimerRecoveryV1";
    const TIMER_MODE_KEY = "codexRealtimeTimerModeV1";
    const ADMIN_TIMER_RESET_KEY = "codexAdminTimerResetAckV1";
    const VERIFY_EMAIL_KEY = "codexVerifyEmailV1";
    const VERIFY_COOLDOWN_KEY = "codexVerifyCooldownUntilV1";
    const NOTE_FOLDER_ALL_ID = "__all__";
    const NOTE_FOLDER_DEFAULT_ID = "general";
    const LOCAL_LEADERBOARD_PREVIEW_ID = "__local_leaderboard_preview__";
    const PUBLIC_PROFILE_COLLECTION = "publicProfiles";
    const LEADERBOARD_COLLECTION = "leaderboard";
    const LEADERBOARD_AUTOSYNC_KEY = "codexLeaderboardAutosyncAtV1";
    const FREE_GENERAL_SUBJECT = "free_general";
    const QUESTION_LIMIT = 500;
    const timerInstanceId = `timer_${Math.random().toString(36).slice(2, 10)}`;

    let noteFolders = [];
    let activeNoteFolderId = NOTE_FOLDER_ALL_ID;
    let activeQuestionDayIdx = null;
    let verifyCooldownInterval = null;
    let leaderboardRealtimeUnsubscribe = null;
    let currentUserResetUnsubscribe = null;
    let currentUserLiveDoc = null;
    let leaderboardRealtimeDocs = [];
    let leaderboardProfileSourceDocs = [];
    let leaderboardLiveSourceDocs = [];
    let legacyWorkingPresenceByUserId = new Map();
    let leaderboardLiveInterval = null;
    let leaderboardCloudPollInterval = null;
    let leaderboardCloudRefreshPromise = null;
    let timerSyncInterval = null;
    let timerOwnerInterval = null;
    let currentUserWriteChain = Promise.resolve();
    let currentUserSaveTimer = null;
    let currentUserSaveNoticePending = false;
    let currentUserSaveResolvers = [];
    let currentUserSaveAuthorized = false;
    let leaderboardCollectionSyncPromise = null;
    let calendarBoundaryInterval = null;
    let lastObservedCalendarMeta = null;
    let manualWriteDepth = 0;
    let immediateUserWriteIntent = false;
    let immediateUserWriteIntentTimer = null;
    let timerOwnershipObserved = false;
    let hasTimerControl = false;
    let requiresEmailVerification = false;
    let taskDragState = null;
    let lastAutoDailyResetSyncSignature = "";
    let hasBootstrappedUsersRealtime = false;

    const timerState = {
        mode: localStorage.getItem(TIMER_MODE_KEY) || "pomodoro",
        session: null,
        syncing: false,
        transitioning: false,
        lastModalSeenAt: Date.now()
    };

    const timerDrafts = {
        pomodoro: null,
        stopwatch: null
    };

    function safeShowAlert(message, type) {
        if (typeof showAlert === "function") {
            showAlert(message, type);
        }
    }

    function escapeHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    const BROKEN_UI_TEXT_REPLACEMENTS = [];

    function normalizeBrokenUiText(value) {
        let nextValue = String(value ?? "");
        BROKEN_UI_TEXT_REPLACEMENTS.forEach(([from, to]) => {
            nextValue = nextValue.split(from).join(to);
        });
        return nextValue;
    }

    function normalizeVisibleUiText(root = document.body) {
        if (!root) return;

        const elementRoot = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
        if (elementRoot && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(elementRoot.tagName)) {
            ["title", "placeholder", "aria-label", "value"].forEach(attributeName => {
                if (!elementRoot.hasAttribute?.(attributeName)) return;
                const currentValue = elementRoot.getAttribute(attributeName) || "";
                const normalizedValue = normalizeBrokenUiText(currentValue);
                if (normalizedValue !== currentValue) {
                    elementRoot.setAttribute(attributeName, normalizedValue);
                }
            });
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parentTag = node.parentElement?.tagName || "";
                return ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parentTag)
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT;
            }
        });

        while (walker.nextNode()) {
            const currentNode = walker.currentNode;
            const currentValue = currentNode.nodeValue || "";
            const normalizedValue = normalizeBrokenUiText(currentValue);
            if (normalizedValue !== currentValue) {
                currentNode.nodeValue = normalizedValue;
            }
        }
    }

    function installVisibleUiTextNormalizer() {
        if (document.documentElement?.dataset.codexUiTextNormalizerInstalled === "true") return;
        if (document.documentElement) {
            document.documentElement.dataset.codexUiTextNormalizerInstalled = "true";
        }

        const observer = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                if (mutation.type === "characterData" && mutation.target) {
                    normalizeVisibleUiText(mutation.target);
                    return;
                }

                mutation.addedNodes?.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
                        normalizeVisibleUiText(node);
                    }
                });
            });
        });

        if (document.body) {
            normalizeVisibleUiText(document.body);
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });
        } else {
            window.addEventListener("DOMContentLoaded", () => {
                normalizeVisibleUiText(document.body);
                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });
            }, { once: true });
        }
    }

    function parseInteger(value, fallback = 0) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function clampNumber(value, min, max) {
        return Math.min(max, Math.max(min, parseInteger(value, min)));
    }

    function getQuestionLimitError() {
        return "En fazla 500 soru girebilirsiniz";
    }

    function normalizeSubjectQuestionMap(rawMap) {
        if (!rawMap || typeof rawMap !== "object") return {};
        const nextMap = {};
        Object.entries(rawMap).forEach(([subjectId, amount]) => {
            const normalizedAmount = clampNumber(amount, 0, QUESTION_LIMIT);
            if (normalizedAmount > 0) {
                nextMap[String(subjectId)] = normalizedAmount;
            }
        });
        return nextMap;
    }

    function getCurrentDayMeta(date = new Date()) {
        return {
            dateKey: date.toLocaleDateString("sv-SE"),
            weekKey: typeof getWeekKey === "function" ? getWeekKey(date) : "",
            dayIdx: (date.getDay() + 6) % 7
        };
    }

    function getMondayWeekStart(date = new Date()) {
        const weekStart = new Date(date);
        weekStart.setHours(0, 0, 0, 0);
        weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
        return weekStart;
    }

    function handleCalendarBoundaryChange(previousMeta = null, referenceDate = new Date()) {
        const nextMeta = getCurrentDayMeta(referenceDate);
        const wasViewingCurrentWeek = Boolean(
            previousMeta?.weekKey
            && currentWeekStart instanceof Date
            && typeof getWeekKey === "function"
            && getWeekKey(currentWeekStart) === previousMeta.weekKey
        );

        if (wasViewingCurrentWeek) {
            currentWeekStart = getMondayWeekStart(referenceDate);
        }

        if (wasViewingCurrentWeek && typeof renderSchedule === "function") {
            renderSchedule();
        } else {
            refreshQuestionSummaryCounters();
            updateLiveStudyPreview();
        }

        refreshLeaderboardOptimistically();
        if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
            renderLiveLeaderboardFromDocs();
        }
        if (currentUser?.uid && !isTimerVisibleForLeaderboard(timerState.session, referenceDate.getTime())) {
            const resetState = getDailySnapshotResetState(currentUserLiveDoc || {}, referenceDate);
            currentUserLiveDoc = resetState.normalizedData;
            if (resetState.needsSync) {
                queueAutoDailyResetSync(referenceDate);
            }
        }

        return nextMeta;
    }

    function ensureCalendarBoundaryWatcher() {
        if (calendarBoundaryInterval) return;

        lastObservedCalendarMeta = getCurrentDayMeta(new Date());
        calendarBoundaryInterval = setInterval(() => {
            const nowDate = new Date();
            const nextMeta = getCurrentDayMeta(nowDate);
            if (
                !lastObservedCalendarMeta
                || nextMeta.dateKey !== lastObservedCalendarMeta.dateKey
                || nextMeta.weekKey !== lastObservedCalendarMeta.weekKey
            ) {
                const previousMeta = lastObservedCalendarMeta;
                lastObservedCalendarMeta = handleCalendarBoundaryChange(previousMeta, nowDate);
            }
        }, 1000);
    }

    function normalizeAdminTimerReset(reset = null) {
        if (!reset || typeof reset !== "object") return null;

        const token = String(reset.token || reset.requestedAt || "").trim();
        const dateKey = String(reset.dateKey || "").trim();
        const requestedAtMs = Math.max(
            parseInteger(reset.requestedAtMs, 0),
            parseInteger(reset.timestamp, 0),
            reset.requestedAt ? new Date(reset.requestedAt).getTime() : 0
        );

        if (!token || !dateKey || !requestedAtMs) return null;

        return {
            token,
            dateKey,
            requestedAtMs,
            requestedBy: String(reset.requestedBy || "").trim(),
            requestedByEmail: String(reset.requestedByEmail || "").trim()
        };
    }

    function getAdminTimerResetSignature(reset = null) {
        const normalizedReset = normalizeAdminTimerReset(reset);
        return normalizedReset ? `${normalizedReset.dateKey}:${normalizedReset.token}` : "";
    }

    function readHandledAdminTimerResetSignature() {
        try {
            return localStorage.getItem(ADMIN_TIMER_RESET_KEY) || "";
        } catch (error) {
            return "";
        }
    }

    function writeHandledAdminTimerResetSignature(reset = null) {
        const signature = getAdminTimerResetSignature(reset);
        if (!signature) return;
        try {
            localStorage.setItem(ADMIN_TIMER_RESET_KEY, signature);
        } catch (error) {
            console.error("Admin timer reset imzasi kaydedilemedi:", error);
        }
    }

    function shouldHonorAdminTimerReset(reset = null) {
        const normalizedReset = normalizeAdminTimerReset(reset);
        if (!normalizedReset) return false;
        if (typeof isCurrentAdmin === "function" && isCurrentAdmin()) return false;
        return normalizedReset.dateKey === getCurrentDayMeta(new Date()).dateKey;
    }

    function shouldForceClearTimerFromAdminReset(reset = null, session = null) {
        const normalizedReset = normalizeAdminTimerReset(reset);
        if (!shouldHonorAdminTimerReset(normalizedReset) || !session) return false;

        const sessionUpdatedAt = Math.max(
            parseInteger(session.updatedAtMs, 0),
            parseInteger(session.startedAtMs, 0)
        );

        return !sessionUpdatedAt || sessionUpdatedAt <= normalizedReset.requestedAtMs;
    }

    function shouldApplyAdminResetSnapshot(reset = null, userData = {}) {
        const normalizedReset = normalizeAdminTimerReset(reset);
        if (!shouldHonorAdminTimerReset(normalizedReset)) return false;

        const lastSyncAt = Math.max(
            parseInteger(userData.lastTimerSyncAt, 0),
            parseInteger(userData.activeTimer?.updatedAtMs, 0)
        );

        return !lastSyncAt || lastSyncAt <= (normalizedReset.requestedAtMs + 1000);
    }

    function clearLegacyPomodoroStorage() {
        localStorage.removeItem("pomodoroDeadline");
        localStorage.removeItem("pomodoroInitialTotal");
    }

    function getFreshForeignActiveTimer(userData = currentUserLiveDoc, now = Date.now()) {
        const activeTimer = userData?.activeTimer;
        if (!isTimerRecordRunning(activeTimer, now)) return null;

        const ownerId = String(activeTimer.ownerId || "").trim();
        if (!ownerId || ownerId === timerInstanceId) return null;

        return activeTimer;
    }

    function queueCurrentUserWrite(label, writeOperation) {
        currentUserWriteChain = currentUserWriteChain
            .catch(() => null)
            .then(async () => {
                if (!currentUser) return null;
                try {
                    return await writeOperation();
                } catch (error) {
                    console.error(`${label} yazimi basarisiz:`, error);
                    throw error;
                }
            });

        return currentUserWriteChain;
    }

    function markImmediateUserWriteIntent() {
        immediateUserWriteIntent = true;
        if (immediateUserWriteIntentTimer) {
            clearTimeout(immediateUserWriteIntentTimer);
        }
        immediateUserWriteIntentTimer = setTimeout(() => {
            immediateUserWriteIntent = false;
            immediateUserWriteIntentTimer = null;
        }, 0);
    }

    function hasManualWriteIntent() {
        return manualWriteDepth > 0 || immediateUserWriteIntent || !!(window.event && window.event.isTrusted);
    }

    function withManualFirestoreWrite(action) {
        manualWriteDepth += 1;
        let result;

        try {
            result = action();
        } catch (error) {
            manualWriteDepth = Math.max(0, manualWriteDepth - 1);
            throw error;
        }

        if (result && typeof result.then === "function") {
            return result.finally(() => {
                manualWriteDepth = Math.max(0, manualWriteDepth - 1);
            });
        }

        manualWriteDepth = Math.max(0, manualWriteDepth - 1);
        return result;
    }

    function ensureManualWriteAllowed(label = "write") {
        if (hasManualWriteIntent()) return true;
        console.warn(`${label} otomatik yazma korumasi nedeniyle engellendi.`);
        return false;
    }

    function installManualWriteIntentCapture() {
        if (document.documentElement?.dataset.codexManualWriteCaptureInstalled === "true") return;
        if (document.documentElement) {
            document.documentElement.dataset.codexManualWriteCaptureInstalled = "true";
        }

        ["pointerdown", "click", "change", "submit", "keydown", "touchend"].forEach(eventName => {
            document.addEventListener(eventName, event => {
                if (event?.isTrusted) {
                    markImmediateUserWriteIntent();
                }
            }, true);
        });
    }

    function flushScheduledCurrentUserSave(options = {}) {
        if (currentUserSaveTimer) {
            clearTimeout(currentUserSaveTimer);
            currentUserSaveTimer = null;
        }

        const label = options.label || "saveData";
        const shouldNotify = options.notify || currentUserSaveNoticePending;
        currentUserSaveNoticePending = false;
        const resolvers = [...currentUserSaveResolvers];
        currentUserSaveResolvers = [];
        const isAuthorized = options.authorized === true || currentUserSaveAuthorized;
        currentUserSaveAuthorized = false;

        if (!currentUser) {
            resolvers.forEach(resolve => resolve());
            return Promise.resolve();
        }

        if (!isAuthorized && !ensureManualWriteAllowed(label)) {
            resolvers.forEach(resolve => resolve());
            return Promise.resolve();
        }

        const writePromise = queueCurrentUserWrite(options.label || "saveData", async () => {
            const payload = typeof buildUserPayload === "function" ? buildUserPayload() : {};
            await db.collection("users").doc(currentUser.uid).set(payload, { merge: true });
            if (shouldNotify) {
                safeShowAlert("Veriler buluta kaydedildi.", "success");
            }
        });

        writePromise.finally(() => {
            resolvers.forEach(resolve => resolve());
        });

        return writePromise;
    }

    function scheduleCurrentUserSave(options = {}) {
        if (!currentUser) return Promise.resolve();

        if (options.notify) {
            currentUserSaveNoticePending = true;
        }

        return new Promise(resolve => {
            currentUserSaveResolvers.push(resolve);
            if (currentUserSaveTimer) {
                clearTimeout(currentUserSaveTimer);
            }

            currentUserSaveTimer = setTimeout(() => {
                flushScheduledCurrentUserSave({
                    notify: options.notify,
                    label: options.label || "saveData"
                }).catch(() => null);
            }, options.immediate ? 0 : USER_SAVE_DEBOUNCE_MS);
        });
    }

    function syncCurrentUserLiveDoc(userData = {}, options = {}) {
        const dailyResetState = getDailySnapshotResetState(userData || {});
        currentUserLiveDoc = dailyResetState.normalizedData;
        mergeFreshDailySnapshotIntoLocalSchedule(currentUserLiveDoc);
        if (dailyResetState.needsSync) {
            queueAutoDailyResetSync();
        }

        const foreignTimer = getFreshForeignActiveTimer(currentUserLiveDoc);
        if (!foreignTimer || !timerState.session?.isRunning) return false;
        if (hasTimerControl && getTimerOwnerId() === timerInstanceId) return false;

        stopTimerLoops();
        isRunning = false;
        persistTimerSessionLocally(null);
        releaseTimerOwnership();

        timerState.session = createEmptyTimerSession(timerState.mode);
        if (timerState.mode === "pomodoro") {
            timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
        }
        timerDrafts[timerState.mode] = { ...timerState.session };
        renderTimerUi();

        if (!options.silent) {
            safeShowAlert("Bu hesapta calisan zamanlayici baska bir cihaz tarafindan kontrol ediliyor.");
        }

        return true;
    }

    function updateLocalActiveTimerSnapshot(activeSession = null) {
        const baseDoc = currentUserLiveDoc && typeof currentUserLiveDoc === "object"
            ? currentUserLiveDoc
            : {};
        const activeTimerRecord = activeSession ? serializeTimerSession(activeSession) : null;

        currentUserLiveDoc = {
            ...baseDoc,
            activeTimer: activeTimerRecord,
            isWorking: isTimerVisibleForLeaderboard(activeTimerRecord)
        };
    }

    function normalizeAdminTimeAdjustment(adjustment = null) {
        if (!adjustment || typeof adjustment !== "object") return null;

        const token = String(adjustment.token || adjustment.requestedAt || "").trim();
        const dateKey = String(adjustment.dateKey || "").trim();
        const weekKey = String(adjustment.weekKey || "").trim();
        const scope = ["today", "week", "total"].includes(adjustment.scope) ? adjustment.scope : "today";
        const requestedAtMs = Math.max(
            parseInteger(adjustment.requestedAtMs, 0),
            parseInteger(adjustment.timestamp, 0),
            adjustment.requestedAt ? new Date(adjustment.requestedAt).getTime() : 0
        );
        const targetSeconds = Math.max(0, parseInteger(adjustment.targetSeconds, 0));
        const appliedDaySeconds = Math.max(
            0,
            parseInteger(adjustment.appliedDaySeconds, 0),
            targetSeconds
        );

        if (!token || !dateKey || !requestedAtMs) return null;

        return {
            token,
            dateKey,
            weekKey,
            scope,
            requestedAtMs,
            targetSeconds,
            appliedDaySeconds
        };
    }

    function getTrackedSubjectIds(dayData = null) {
        const autoSubjects = typeof normalizeSelectedSubjects === "function"
            ? normalizeSelectedSubjects(studyTrack || "", selectedSubjects || [])
            : (Array.isArray(selectedSubjects) ? [...selectedSubjects] : []);

        if (autoSubjects.length) return autoSubjects;

        if (dayData && Array.isArray(dayData.tasks) && typeof matchTaskSubjects === "function") {
            const matched = new Set();
            dayData.tasks.forEach(task => {
                matchTaskSubjects(task.text || "", Object.keys(SUBJECT_DEFINITIONS || {})).forEach(subjectId => matched.add(subjectId));
            });
            if (matched.size) return [...matched];
        }

        return [FREE_GENERAL_SUBJECT];
    }

    function getSubjectLabel(subjectId) {
        if (subjectId === FREE_GENERAL_SUBJECT) return "Genel";
        return SUBJECT_DEFINITIONS?.[subjectId]?.label || subjectId;
    }

    function createFallbackSubjectQuestionMap(dayData, totalQuestions) {
        const taskOptions = getDayQuestionSubjectOptions(dayData);
        const tracked = getTrackedSubjectIds(dayData);
        const primarySubjectId = taskOptions[0] || tracked[0] || FREE_GENERAL_SUBJECT;
        return totalQuestions > 0 ? { [primarySubjectId]: totalQuestions } : {};
    }

    function ensureDayObject(day = {}) {
        const workedSeconds = Math.max(0, parseInteger(day.workedSeconds, 0));
        const rawQuestions = Math.max(0, parseInteger(day.questions, 0));
        const subjectQuestions = normalizeSubjectQuestionMap(day.subjectQuestions || {});
        const subjectQuestionTotal = Object.values(subjectQuestions).reduce((sum, amount) => sum + amount, 0);
        const normalizedQuestions = Math.min(QUESTION_LIMIT, subjectQuestionTotal || rawQuestions);

        return {
            ...day,
            tasks: Array.isArray(day.tasks)
                ? day.tasks.map(task => ({
                    text: String(task && task.text ? task.text : "").trim(),
                    completed: !!(task && task.completed)
                })).filter(task => task.text)
                : [],
            workedSeconds,
            questions: normalizedQuestions,
            subjectQuestions: subjectQuestionTotal ? subjectQuestions : (normalizedQuestions ? createFallbackSubjectQuestionMap(day, normalizedQuestions) : {})
        };
    }

    function sanitizeScheduleData(schedule = {}) {
        const nextSchedule = {};
        Object.entries(schedule || {}).forEach(([weekKey, week]) => {
            if (!week || typeof week !== "object") return;
            nextSchedule[weekKey] = {};
            Object.entries(week).forEach(([dayIdx, dayValue]) => {
                nextSchedule[weekKey][dayIdx] = ensureDayObject(dayValue || {});
            });
        });
        return nextSchedule;
    }

    function ensureWeekDay(weekKey, dayIdx) {
        scheduleData = sanitizeScheduleData(scheduleData || {});
        if (!scheduleData[weekKey]) scheduleData[weekKey] = {};
        if (!scheduleData[weekKey][dayIdx]) scheduleData[weekKey][dayIdx] = ensureDayObject({});
        scheduleData[weekKey][dayIdx] = ensureDayObject(scheduleData[weekKey][dayIdx]);
        return scheduleData[weekKey][dayIdx];
    }

    function getRenderableSubjectQuestionEntries(dayData) {
        const normalizedDay = ensureDayObject(dayData || {});
        const entries = Object.entries(normalizedDay.subjectQuestions || {})
            .map(([subjectId, amount]) => ({ subjectId, amount }))
            .filter(item => item.amount > 0)
            .sort((a, b) => b.amount - a.amount || getSubjectLabel(a.subjectId).localeCompare(getSubjectLabel(b.subjectId), "tr"));

        if (entries.length) return entries;
        if (normalizedDay.questions > 0) {
            const fallbackMap = createFallbackSubjectQuestionMap(normalizedDay, normalizedDay.questions);
            return Object.entries(fallbackMap).map(([subjectId, amount]) => ({ subjectId, amount }));
        }
        return [];
    }

    function applyTurkishInputSupport() {
        document.querySelectorAll("input:not([type='number']), textarea").forEach(field => {
            field.setAttribute("lang", "tr");
            if (!field.getAttribute("inputmode")) {
                field.setAttribute("inputmode", "text");
            }
            field.setAttribute("autocorrect", "on");
            field.setAttribute("autocapitalize", field.tagName === "TEXTAREA" ? "sentences" : "none");
            field.spellcheck = true;
        });
    }

    function ensureVerificationCard() {
        const loginBox = document.querySelector("#login-gate .login-box");
        if (!loginBox) return null;

        let card = document.getElementById("email-verification-card");
        if (!card) {
            card = document.createElement("div");
            card.id = "email-verification-card";
            card.className = "email-verify-card";
            card.innerHTML = `
                <div class="email-verify-card__icon"><i class="fas fa-envelope-open-text"></i></div>
                <h3>Email Dogrulamasi Gerekli</h3>
                <p id="email-verification-message">${escapeHtml(VERIFY_MESSAGE)}</p>
                <div id="email-verification-meta" class="email-verify-card__meta"></div>
                <div class="email-verify-card__actions">
                    <button id="email-verification-resend-btn" type="button" style="background-color: var(--accent-color); color: var(--header-text);">
                        Tekrar Gonder
                    </button>
                    <button id="email-verification-refresh-btn" type="button" style="background-color: var(--countdown-fill); color: var(--header-text);">
                        Kontrol Et
                    </button>
                    <button id="email-verification-logout-btn" type="button" style="background-color: var(--button-bg); color: var(--header-text);">
                        Cikis Yap
                    </button>
                </div>
            `;

            loginBox.insertBefore(card, document.getElementById("login-error-message"));

            card.querySelector("#email-verification-resend-btn")?.addEventListener("click", resendVerificationEmail);
            card.querySelector("#email-verification-refresh-btn")?.addEventListener("click", checkEmailVerificationStatus);
            card.querySelector("#email-verification-logout-btn")?.addEventListener("click", () => {
                localStorage.removeItem(VERIFY_EMAIL_KEY);
                localStorage.removeItem(VERIFY_COOLDOWN_KEY);
                hideVerificationGate();
                if (typeof signOutUser === "function") {
                    signOutUser();
                } else if (auth?.signOut) {
                    auth.signOut();
                }
            });
        }

        return card;
    }

    function setVerificationMeta(message = "", isSuccess = false) {
        const meta = document.getElementById("email-verification-meta");
        if (!meta) return;
        meta.textContent = message;
        meta.style.color = isSuccess ? "#a7f3d0" : "rgba(234, 241, 255, 0.78)";
    }

    function hideVerificationGate() {
        const gate = document.getElementById("login-gate");
        const loginBox = document.querySelector("#login-gate .login-box");
        const card = document.getElementById("email-verification-card");

        if (card) card.classList.remove("is-visible");
        if (loginBox) loginBox.classList.remove("is-verification-mode");
        document.body.classList.remove("email-verification-required");

        if (currentUser && currentUser.emailVerified && gate) {
            gate.style.opacity = "0";
            setTimeout(() => {
                if (currentUser && currentUser.emailVerified) {
                    gate.style.display = "none";
                }
            }, 220);
        }
    }

    function isVerificationPending() {
        return !!(currentUser && requiresEmailVerification && !currentUser.emailVerified);
    }

    function showVerificationGate(options = {}) {
        const gate = document.getElementById("login-gate");
        const loginBox = document.querySelector("#login-gate .login-box");
        const card = ensureVerificationCard();

        if (!gate || !loginBox || !card) return;

        const email = options.email || currentUser?.email || localStorage.getItem(VERIFY_EMAIL_KEY) || "";
        if (email) {
            localStorage.setItem(VERIFY_EMAIL_KEY, email);
        }

        gate.style.display = "flex";
        gate.style.opacity = "1";
        card.classList.add("is-visible");
        loginBox.classList.add("is-verification-mode");
        document.body.classList.add("email-verification-required");

        const messageNode = document.getElementById("email-verification-message");
        if (messageNode) {
            messageNode.textContent = options.message || VERIFY_MESSAGE;
        }

        setVerificationMeta(options.meta || "", !!options.success);
        refreshVerificationCooldownUI();

        const onboardingModal = document.getElementById("onboarding-modal");
        if (onboardingModal) onboardingModal.style.display = "none";
        if (typeof syncBodyModalLock === "function") syncBodyModalLock();
    }

    function refreshVerificationCooldownUI() {
        const resendButton = document.getElementById("email-verification-resend-btn");
        if (!resendButton) return;

        const until = parseInteger(localStorage.getItem(VERIFY_COOLDOWN_KEY), 0);
        const remainingMs = until - Date.now();

        if (remainingMs > 0) {
            const seconds = Math.ceil(remainingMs / 1000);
            resendButton.disabled = true;
            resendButton.innerHTML = `Tekrar Gönder (${seconds}s)`;
        } else {
            resendButton.disabled = false;
            resendButton.innerHTML = "Tekrar Gönder";
        }

        if (verifyCooldownInterval) {
            clearInterval(verifyCooldownInterval);
            verifyCooldownInterval = null;
        }

        if (remainingMs > 0) {
            verifyCooldownInterval = setInterval(() => {
                const currentUntil = parseInteger(localStorage.getItem(VERIFY_COOLDOWN_KEY), 0);
                const currentRemaining = currentUntil - Date.now();
                if (currentRemaining <= 0) {
                    clearInterval(verifyCooldownInterval);
                    verifyCooldownInterval = null;
                    resendButton.disabled = false;
                    resendButton.innerHTML = "Tekrar Gönder";
                    return;
                }
                resendButton.innerHTML = `Tekrar Gönder (${Math.ceil(currentRemaining / 1000)}s)`;
            }, 500);
        }
    }

    async function resendVerificationEmail() {
        if (!currentUser) {
            setVerificationMeta("Doğrulama bağlantısını tekrar göndermek için hesabın açık olmalı.");
            return;
        }

        const cooldownUntil = parseInteger(localStorage.getItem(VERIFY_COOLDOWN_KEY), 0);
        if (cooldownUntil > Date.now()) {
            refreshVerificationCooldownUI();
            return;
        }

        const resendButton = document.getElementById("email-verification-resend-btn");
        if (resendButton) {
            resendButton.disabled = true;
            resendButton.innerHTML = "Gönderiliyor...";
        }

        try {
            await currentUser.reload();
            if (currentUser.emailVerified) {
                setVerificationMeta("Email doğrulandı. Giriş alanı açılıyor.", true);
                hideVerificationGate();
                return;
            }

            await currentUser.sendEmailVerification();
            localStorage.setItem(VERIFY_COOLDOWN_KEY, String(Date.now() + VERIFY_COOLDOWN_MS));
            setVerificationMeta("Doğrulama bağlantısı tekrar gönderildi.", true);
            safeShowAlert("Doğrulama bağlantısı tekrar gönderildi.", "success");
        } catch (error) {
            console.error("Email doğrulama yeniden gönderilemedi:", error);
            setVerificationMeta("Bağlantı gönderilirken bir hata oluştu. Lütfen tekrar dene.");
        } finally {
            refreshVerificationCooldownUI();
        }
    }

    async function checkEmailVerificationStatus() {
        if (!currentUser) {
            setVerificationMeta("Önce hesabına giriş yapmalısın.");
            return;
        }

        setVerificationMeta("Doğrulama durumu kontrol ediliyor...");

        try {
            await currentUser.reload();
            if (currentUser.emailVerified) {
                setVerificationMeta("Email doğrulandı. Hoş geldin.", true);
                safeShowAlert("Email doğrulandı. Uygulamaya giriş yapıldı.", "success");
                hideVerificationGate();
                return;
            }
            setVerificationMeta("Doğrulama henüz görünmüyor. Mail kutunu tekrar kontrol et.");
        } catch (error) {
            console.error("Email doğrulama durumu okunamadi:", error);
            setVerificationMeta("Doğrulama bilgisi alınamadı. İnternet bağlantını kontrol et.");
        }
    }

    function translateExtendedAuthError(error, mode = "login") {
        const existing = typeof translateAuthError === "function" ? translateAuthError(error, mode) : "";
        if (existing) return existing;
        return "Bir hata oluştu. Lütfen tekrar dene.";
    }

    function setAuthErrorMessage(message = "") {
        const node = document.getElementById("login-error-message");
        if (node) node.textContent = message;
    }

    function createSignupPayload(username, email, accountCreatedAt) {
        const nowMs = Date.now();
        const adminProfile = typeof getAdminProfileMeta === "function"
            ? getAdminProfileMeta(username, email)
            : {
                isAdmin: typeof isAdminIdentity === "function" ? isAdminIdentity(username, email) : false,
                role: (typeof isAdminIdentity === "function" && isAdminIdentity(username, email)) ? "admin" : "user",
                adminTitle: (typeof isAdminIdentity === "function" && isAdminIdentity(username, email)) ? "Kurucu Admin" : ""
            };
        return {
            username,
            email,
            emailVerified: false,
            requiresEmailVerification: true,
            ...adminProfile,
            about: "",
            profileImage: "",
            accountCreatedAt,
            studyTrack: "",
            selectedSubjects: [],
            notes: [],
            noteFolders: normalizeNoteFolders([]),
            supportMessages: [],
            schedule: {},
            totalWorkedSeconds: 0,
            totalStudyTime: 0,
            totalQuestionsAllTime: 0,
            selectedTitleId: "",
            titleAwards: {},
            name: username,
            isRunning: false,
            lastSyncTime: nowMs,
            totalTime: 0,
            dailyStudyTime: 0,
            dailyStudyDateKey: getCurrentDayMeta(new Date()).dateKey,
            currentSessionTime: 0,
            activeTimer: null,
            isWorking: false,
            lastTimerSyncAt: nowMs
        };
    }

    function updateEmailVerificationField(user, options = {}) {
        if (!user) return Promise.resolve();
        const patch = {
            email: user.email || "",
            emailVerified: !!user.emailVerified
        };

        if (user.emailVerified) {
            patch.requiresEmailVerification = false;
        } else if (options.forceGate) {
            patch.requiresEmailVerification = true;
        }

        return db.collection("users").doc(user.uid).get().then(doc => {
            if (!doc.exists) return;
            if (!ensureManualWriteAllowed("email-dogrulama")) return;
            return db.collection("users").doc(user.uid).set(patch, { merge: true });
        }).catch(error => {
            console.error("Email doğrulama alanı yazilamadi:", error);
        });
    }

    function guardVerifiedAccess() {
        if (isVerificationPending()) {
            showVerificationGate();
            return true;
        }
        return false;
    }

    function getTimerOwnerHeartbeat() {
        return parseInteger(localStorage.getItem(TIMER_OWNER_AT_KEY), 0);
    }

    function getTimerOwnerId() {
        return localStorage.getItem(TIMER_OWNER_KEY) || "";
    }

    function claimTimerOwnership(force = false) {
        const ownerId = getTimerOwnerId();
        const ownerHeartbeat = getTimerOwnerHeartbeat();
        const now = Date.now();
        const stale = now - ownerHeartbeat > TIMER_OWNER_TTL_MS;

        if (force || !ownerId || ownerId === timerInstanceId || stale) {
            localStorage.setItem(TIMER_OWNER_KEY, timerInstanceId);
            localStorage.setItem(TIMER_OWNER_AT_KEY, String(now));
            hasTimerControl = true;
            return true;
        }

        hasTimerControl = ownerId === timerInstanceId;
        return hasTimerControl;
    }

    function refreshTimerOwnership() {
        if (!hasTimerControl) return;
        localStorage.setItem(TIMER_OWNER_KEY, timerInstanceId);
        localStorage.setItem(TIMER_OWNER_AT_KEY, String(Date.now()));
    }

    function releaseTimerOwnership() {
        if (getTimerOwnerId() === timerInstanceId) {
            localStorage.removeItem(TIMER_OWNER_KEY);
            localStorage.removeItem(TIMER_OWNER_AT_KEY);
        }
        hasTimerControl = false;
    }

    function observeTimerOwnership() {
        if (timerOwnershipObserved) return;
        timerOwnershipObserved = true;

        window.addEventListener("storage", event => {
            if (event.key === TIMER_OWNER_KEY || event.key === TIMER_OWNER_AT_KEY) {
                const ownerId = getTimerOwnerId();
                hasTimerControl = ownerId === timerInstanceId;
            }
        });
    }

    function isTimerModalOpen() {
        const modal = document.getElementById("pomodoro-modal");
        if (!modal) return false;
        if (modal.style.display === "none") return false;
        return window.getComputedStyle(modal).display !== "none";
    }

    function touchTimerVisibility(referenceMs = Date.now(), options = {}) {
        const safeReferenceMs = Math.max(0, parseInteger(referenceMs, Date.now()));
        timerState.lastModalSeenAt = safeReferenceMs;

        if (!timerState.session) return safeReferenceMs;

        timerState.session.lastSeenAtMs = safeReferenceMs;
        timerState.session.modalOpen = options.modalOpen === undefined
            ? isTimerModalOpen()
            : !!options.modalOpen;
        timerDrafts[timerState.session.mode] = { ...timerState.session };

        if (options.persist) {
            persistTimerSessionLocally(timerState.session);
        }

        return safeReferenceMs;
    }

    function getTimerLastSeenAt(timerRecord) {
        return Math.max(
            0,
            parseInteger(timerRecord?.lastSeenAtMs, 0),
            parseInteger(timerRecord?.updatedAtMs, 0),
            parseInteger(timerRecord?.startedAtMs, 0)
        );
    }

    function isTimerVisibleForLeaderboard(timerRecord, now = Date.now()) {
        return isTimerRecordRunning(timerRecord, now);
    }

    function serializeTimerSession(session) {
        if (!session) return null;
        const modalOpen = session.modalOpen === undefined ? isTimerModalOpen() : !!session.modalOpen;
        const lastSeenAtMs = Math.max(
            getTimerLastSeenAt(session),
            modalOpen ? Date.now() : 0,
            parseInteger(timerState.lastModalSeenAt, 0)
        );
        return {
            uid: String(session.uid || currentUser?.uid || ""),
            mode: session.mode,
            isRunning: !!session.isRunning,
            baseElapsedSeconds: Math.max(0, parseInteger(session.baseElapsedSeconds, 0)),
            lastPersistedElapsedSeconds: Math.max(0, parseInteger(session.lastPersistedElapsedSeconds, 0)),
            targetDurationSeconds: Math.max(0, parseInteger(session.targetDurationSeconds, 0)),
            startedAtMs: session.isRunning ? parseInteger(session.startedAtMs, Date.now()) : 0,
            updatedAtMs: Date.now(),
            ownerId: timerInstanceId,
            modalOpen,
            lastSeenAtMs
        };
    }

    function createCommitSourceSession(session = timerState.session) {
        if (!session) return null;
        return {
            ...serializeTimerSession(session),
            ownerId: session.ownerId || timerInstanceId
        };
    }

    function persistTimerSessionLocally(session) {
        const sessionUid = String(session?.uid || currentUser?.uid || "");
        if (!session || !sessionUid) {
            localStorage.removeItem(TIMER_STORAGE_KEY);
            return;
        }
        localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(serializeTimerSession({
            ...session,
            uid: sessionUid
        })));
    }

    function readStoredTimerSession() {
        try {
            const raw = localStorage.getItem(TIMER_STORAGE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (error) {
            console.error("Timer local verisi okunamadi:", error);
            return null;
        }
    }

    function preserveTimerStateForRecovery(session = timerState.session, options = {}) {
        if (!session) return false;

        const uid = String(
            options.uid
            || session.uid
            || currentUser?.uid
            || currentUserLiveDoc?.uid
            || ""
        );

        if (!uid) return false;

        const snapshot = {
            ...session,
            uid,
            modalOpen: options.modalOpen === undefined ? !!session.modalOpen : !!options.modalOpen,
            lastSeenAtMs: Math.max(
                getTimerLastSeenAt(session),
                parseInteger(options.lastSeenAtMs, 0),
                Date.now()
            )
        };

        persistTimerSessionLocally(snapshot);
        if (options.includeRecovery !== false && currentUser?.uid === uid) {
            persistTimerRecoverySnapshot();
        }
        return true;
    }

    function buildTimerRecoverySnapshot() {
        if (!currentUser?.uid) return null;
        scheduleData = sanitizeScheduleData(scheduleData || {});
        if (typeof refreshCurrentTotals === "function") {
            refreshCurrentTotals();
        }
        return {
            uid: currentUser.uid,
            schedule: scheduleData,
            totalWorkedSecondsAllTime: totalWorkedSecondsAllTime || 0,
            totalQuestionsAllTime: totalQuestionsAllTime || 0,
            savedAt: Date.now()
        };
    }

    function persistTimerRecoverySnapshot() {
        const snapshot = buildTimerRecoverySnapshot();
        if (!snapshot) return false;
        try {
            localStorage.setItem(TIMER_RECOVERY_KEY, JSON.stringify(snapshot));
            return true;
        } catch (error) {
            console.error("Timer kurtarma verisi saklanamadi:", error);
            return false;
        }
    }

    function readTimerRecoverySnapshot() {
        try {
            const raw = localStorage.getItem(TIMER_RECOVERY_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (error) {
            console.error("Timer kurtarma verisi okunamadi:", error);
            return null;
        }
    }

    function clearTimerRecoverySnapshot(expectedUid = currentUser?.uid || "") {
        const snapshot = readTimerRecoverySnapshot();
        if (!snapshot) return false;
        if (expectedUid && snapshot.uid && snapshot.uid !== expectedUid) {
            return false;
        }
        try {
            localStorage.removeItem(TIMER_RECOVERY_KEY);
            return true;
        } catch (error) {
            console.error("Timer kurtarma verisi silinemedi:", error);
            return false;
        }
    }

    function monitorTimerSyncPromise(promise, options = {}) {
        const label = String(options.label || "timer-sync");
        const timeoutMs = Math.max(500, parseInteger(options.timeoutMs, TIMER_ACTION_TIMEOUT_MS));
        const failureMessage = String(options.failureMessage || "");
        const timeoutMessage = String(options.timeoutMessage || "");
        const failureType = String(options.failureType || "info");
        const timeoutType = String(options.timeoutType || failureType);
        let finished = false;
        let timeoutNoticeShown = false;
        let timeoutId = null;

        if (timeoutMessage) {
            timeoutId = setTimeout(() => {
                if (finished) return;
                timeoutNoticeShown = true;
                safeShowAlert(timeoutMessage, timeoutType);
            }, timeoutMs);
        }

        Promise.resolve(promise).then(() => {
            finished = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (typeof options.onSuccess === "function") {
                options.onSuccess();
            }
        }).catch(error => {
            finished = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (options.persistRecovery !== false) {
                persistTimerRecoverySnapshot();
            }
            console.error(`${label} senkronu basarisiz:`, error);
            if (failureMessage && (!timeoutNoticeShown || failureMessage !== timeoutMessage)) {
                safeShowAlert(failureMessage, failureType);
            }
            if (typeof options.onFailure === "function") {
                options.onFailure(error);
            }
        });

        return promise;
    }

    function mergeTimerRecoveryScheduleIntoLocalState() {
        const snapshot = readTimerRecoverySnapshot();
        if (!snapshot || !currentUser?.uid || snapshot.uid !== currentUser.uid) {
            return false;
        }

        const recoverySchedule = sanitizeScheduleData(snapshot.schedule || {});
        if (!Object.keys(recoverySchedule).length) {
            return false;
        }

        scheduleData = sanitizeScheduleData(scheduleData || {});
        let changed = false;

        Object.entries(recoverySchedule).forEach(([weekKey, weekData]) => {
            if (!scheduleData[weekKey]) scheduleData[weekKey] = {};

            Object.entries(weekData || {}).forEach(([dayIdx, recoveryDay]) => {
                const localDay = ensureDayObject(scheduleData?.[weekKey]?.[dayIdx] || {});
                const recoveredDay = ensureDayObject(recoveryDay || {});
                const mergedWorkedSeconds = Math.max(
                    parseInteger(localDay.workedSeconds, 0),
                    parseInteger(recoveredDay.workedSeconds, 0)
                );
                const mergedQuestions = Math.max(
                    parseInteger(localDay.questions, 0),
                    parseInteger(recoveredDay.questions, 0)
                );
                const mergedTasks = localDay.tasks?.length ? localDay.tasks : recoveredDay.tasks;
                const mergedSubjectQuestions = Object.keys(localDay.subjectQuestions || {}).length
                    ? localDay.subjectQuestions
                    : recoveredDay.subjectQuestions;

                if (
                    mergedWorkedSeconds !== parseInteger(localDay.workedSeconds, 0)
                    || mergedQuestions !== parseInteger(localDay.questions, 0)
                    || mergedTasks !== localDay.tasks
                    || mergedSubjectQuestions !== localDay.subjectQuestions
                ) {
                    changed = true;
                }

                scheduleData[weekKey][dayIdx] = ensureDayObject({
                    ...recoveredDay,
                    ...localDay,
                    tasks: mergedTasks,
                    subjectQuestions: mergedSubjectQuestions,
                    workedSeconds: mergedWorkedSeconds,
                    questions: mergedQuestions
                });
            });
        });

        if (changed && typeof refreshCurrentTotals === "function") {
            refreshCurrentTotals();
        }
        return changed;
    }

    function createEmptyTimerSession(mode = timerState.mode) {
        return {
            mode,
            isRunning: false,
            baseElapsedSeconds: 0,
            lastPersistedElapsedSeconds: 0,
            targetDurationSeconds: mode === "pomodoro" ? getPomodoroSeedSeconds() : 0,
            startedAtMs: 0,
            modalOpen: false,
            lastSeenAtMs: 0
        };
    }

    function getPomodoroInputSeconds() {
        const hours = clampNumber(document.getElementById("study-hours")?.value, 0, 9);
        const minutes = clampNumber(document.getElementById("study-minutes")?.value, 0, 59);
        const seconds = clampNumber(document.getElementById("study-seconds")?.value, 0, 59);
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    function getPomodoroSeedSeconds() {
        return Math.max(0, getPomodoroInputSeconds());
    }

    function getTimerElapsedSeconds(session = timerState.session, now = Date.now()) {
        if (!session) return 0;
        const baseElapsed = Math.max(0, parseInteger(session.baseElapsedSeconds, 0));
        const lastSeenAtMs = getTimerLastSeenAt(session);
        const effectiveNow = lastSeenAtMs > 0
            ? Math.min(now, lastSeenAtMs + TIMER_AUTO_STOP_MS)
            : now;
        if (!session.isRunning || !session.startedAtMs) {
            return baseElapsed;
        }
        const runtime = Math.max(0, Math.floor((effectiveNow - parseInteger(session.startedAtMs, effectiveNow)) / 1000));
        return baseElapsed + runtime;
    }

    function isTimerRecordRunning(timerRecord, now = Date.now()) {
        if (!timerRecord || !timerRecord.isRunning) return false;
        const lastSeenAtMs = getTimerLastSeenAt(timerRecord);
        if (lastSeenAtMs > 0 && (now - lastSeenAtMs) >= TIMER_AUTO_STOP_MS) return false;
        return true;
    }

    function getTimerDisplaySeconds(session = timerState.session) {
        if (!session) return timerState.mode === "pomodoro" ? getPomodoroInputSeconds() : 0;
        const elapsed = getTimerElapsedSeconds(session);
        if (session.mode === "stopwatch") return elapsed;
        return Math.max(0, parseInteger(session.targetDurationSeconds, 0) - elapsed);
    }

    function renderSegmentedTimer(secondsValue) {
        const timerDisplay = document.getElementById("timer-display");
        if (!timerDisplay) return;

        if (!timerDisplay.dataset.segmentedPomodoro) {
            timerDisplay.dataset.segmentedPomodoro = "true";
            timerDisplay.innerHTML = [
                '<span class="timer-display__group"><span class="timer-display__value" data-part="hours">00</span></span>',
                '<span class="timer-display__separator" aria-hidden="true">:</span>',
                '<span class="timer-display__group"><span class="timer-display__value" data-part="minutes">00</span></span>',
                '<span class="timer-display__separator" aria-hidden="true">:</span>',
                '<span class="timer-display__group"><span class="timer-display__value" data-part="seconds">00</span></span>'
            ].join("");
        }

        const safeSeconds = Math.max(0, parseInteger(secondsValue, 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const seconds = safeSeconds % 60;

        const parts = {
            hours: String(hours).padStart(2, "0"),
            minutes: String(minutes).padStart(2, "0"),
            seconds: String(seconds).padStart(2, "0")
        };

        Object.entries(parts).forEach(([part, value]) => {
            const node = timerDisplay.querySelector(`[data-part="${part}"]`);
            if (node) node.textContent = value;
        });
    }

    function updateTimerStatus(statusText) {
        const statusNode = document.getElementById("timer-status");
        if (!statusNode) return;
        statusNode.textContent = statusText;
        statusNode.style.display = statusText ? "" : "none";
    }

    function updateTimerButtons() {
        const startPauseButton = document.getElementById("start-pause-btn");
        const saveButton = document.getElementById("save-btn");
        const resetButton = document.getElementById("reset-btn");
        const controls = startPauseButton?.closest(".timer-controls");

        if (!startPauseButton || !resetButton) return;
        if (controls) {
            delete controls.dataset.saveHidden;
        }
        if (saveButton) {
            saveButton.style.display = "";
            saveButton.removeAttribute("aria-hidden");
            saveButton.innerHTML = '<i class="fas fa-save"></i> Kaydet ve Kapat';
        }

        const hasProgress = !!timerState.session && getTimerElapsedSeconds(timerState.session) > 0;
        const running = !!timerState.session?.isRunning;
        const isStopwatch = timerState.mode === "stopwatch";

        if (running) {
            startPauseButton.innerHTML = '<i class="fas fa-pause"></i> Duraklat';
        } else if (hasProgress) {
            startPauseButton.innerHTML = '<i class="fas fa-play"></i> Devam Et';
        } else {
            startPauseButton.innerHTML = `<i class="fas fa-play"></i> ${isStopwatch ? "Kronometre Baslat" : "Pomodoro Baslat"}`;
        }

        resetButton.innerHTML = '<i class="fas fa-rotate-left"></i> Sifirla';
    }

    function updateTimerSessionPill() {
        let pill = document.getElementById("timer-session-pill");
        const content = document.querySelector("#pomodoro-modal .pomodoro-content");
        if (!content) return;

        if (!pill) {
            pill = document.createElement("div");
            pill.id = "timer-session-pill";
            pill.className = "timer-session-pill";
            const statusNode = document.getElementById("timer-status");
            if (statusNode) {
                statusNode.insertAdjacentElement("beforebegin", pill);
            }
        }

        const unsynced = timerState.session ? Math.max(0, getTimerElapsedSeconds(timerState.session) - parseInteger(timerState.session.lastPersistedElapsedSeconds, 0)) : 0;
        const modeLabel = timerState.mode === "stopwatch" ? "Kronometre" : "Pomodoro";
        pill.innerHTML = `<i class="fas fa-wave-square"></i> ${modeLabel} - Otomatik kayit acik${unsynced > 0 ? ` - ${unsynced}s bekleyen senkron` : ""}`;
    }

    function renderTimerUi() {
        const content = document.querySelector("#pomodoro-modal .pomodoro-content");
        if (!content) return;

        if (timerState.session?.isRunning) {
            touchTimerVisibility(Date.now(), { modalOpen: isTimerModalOpen() });
        }

        content.classList.toggle("is-stopwatch-mode", timerState.mode === "stopwatch");
        updateTimerButtons();
        updateTimerSessionPill();

        const displaySeconds = getTimerDisplaySeconds();
        timeRemaining = displaySeconds;
        renderSegmentedTimer(displaySeconds);

        if (timerState.session?.isRunning) {
            updateTimerStatus(timerState.mode === "stopwatch"
                ? "Kronometre calisiyor."
                : "Pomodoro calisiyor.");
        } else {
            updateTimerStatus("");
        }

        updateLiveStudyPreview();
    }

    async function maybeAutoStopHiddenTimer() {
        if (timerState.transitioning || !timerState.session?.isRunning || isTimerModalOpen()) {
            return false;
        }
        if (isTimerRecordRunning(timerState.session)) {
            return false;
        }

        timerState.transitioning = true;

        try {
            const session = timerState.session;
            const commitSourceSession = createCommitSourceSession(session);
            const elapsed = getTimerElapsedSeconds(commitSourceSession);

            session.baseElapsedSeconds = elapsed;
            session.isRunning = false;
            session.startedAtMs = 0;
            session.modalOpen = false;
            timerState.session = session;
            timerDrafts[session.mode] = { ...session };
            isRunning = false;
            stopTimerLoops();

            await syncRealtimeTimer("auto-stop-hidden", {
                activeSession: session,
                currentSessionTime: 0,
                commitElapsed: true,
                commitSourceSession,
                committedElapsedSeconds: elapsed,
                userTriggeredWrite: true,
                authorized: true
            });

            releaseTimerOwnership();
            renderTimerUi();
            safeShowAlert("Timer 3 saat sonunda otomatik durduruldu.", "info");
            return true;
        } finally {
            timerState.transitioning = false;
        }
    }

    function ensureTimerModeUi() {
        const content = document.querySelector("#pomodoro-modal .pomodoro-content");
        const titleNode = content?.querySelector("h2");
        const inputGroup = content?.querySelector(".pomodoro-time-inputs");
        if (!content || !titleNode || !inputGroup) return;

        if (!document.getElementById("timer-mode-toggle")) {
            const toggle = document.createElement("div");
            toggle.id = "timer-mode-toggle";
            toggle.className = "timer-mode-toggle";
            toggle.innerHTML = `
                <button class="timer-mode-toggle__button" type="button" data-mode="pomodoro">Pomodoro</button>
                <button class="timer-mode-toggle__button" type="button" data-mode="stopwatch">Kronometre</button>
            `;
            titleNode.insertAdjacentElement("afterend", toggle);

            toggle.querySelectorAll("[data-mode]").forEach(button => {
                button.addEventListener("click", () => setTimerMode(button.dataset.mode));
            });
        }

        if (!document.getElementById("timer-mode-note")) {
            const note = document.createElement("p");
            note.id = "timer-mode-note";
            note.className = "timer-mode-note";
            inputGroup.insertAdjacentElement("beforebegin", note);
        }
    }

    function setTimerMode(mode, options = {}) {
        const normalizedMode = mode === "stopwatch" ? "stopwatch" : "pomodoro";

        if (!options.keepSession && timerState.session && timerState.session.mode !== normalizedMode) {
            const frozenSession = {
                ...timerState.session,
                baseElapsedSeconds: getTimerElapsedSeconds(timerState.session),
                lastPersistedElapsedSeconds: getTimerElapsedSeconds(timerState.session),
                isRunning: false,
                startedAtMs: 0
            };
            timerDrafts[timerState.session.mode] = frozenSession;

            if (timerState.session.isRunning) {
                applyPendingTimerDelta(timerState.session);
                syncRealtimeTimer("mode-switch", {
                    activeSession: null,
                    currentSessionTime: 0,
                    clearActive: true
                });
            }

            stopTimerLoops();
            isRunning = false;
            timerState.session = null;
        }

        timerState.mode = normalizedMode;

        if (options.persist !== false) {
            localStorage.setItem(TIMER_MODE_KEY, normalizedMode);
        }

        document.querySelectorAll("#timer-mode-toggle [data-mode]").forEach(button => {
            button.classList.toggle("is-active", button.dataset.mode === normalizedMode);
        });

        const note = document.getElementById("timer-mode-note");
        if (note) {
            note.innerHTML = normalizedMode === "stopwatch"
                ? "<strong>Kronometre</strong> 00:00:00'dan baslar ve ileri sayar. Durdurulmazsa 3 saat sonunda otomatik durur."
                : "<strong>Pomodoro</strong> geri sayim yapar; sure 0 olsa da sen durdurana kadar calismayi surdurur. Acik kalan timer 3 saat sonunda otomatik durur.";
        }

        if (!options.keepSession) {
            const savedDraft = timerDrafts[normalizedMode];
            if (!timerState.session || timerState.session.mode !== normalizedMode || !timerState.session.isRunning) {
                timerState.session = savedDraft
                    ? { ...savedDraft }
                    : (normalizedMode === "pomodoro"
                        ? createEmptyTimerSession("pomodoro")
                        : createEmptyTimerSession("stopwatch"));

                if (normalizedMode === "pomodoro" && !savedDraft) {
                    timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
                }
            }
        }

        renderTimerUi();
    }

    function stopTimerLoops() {
        clearInterval(timerInterval);
        clearInterval(timerSyncInterval);
        clearInterval(timerOwnerInterval);
        timerInterval = null;
        timerSyncInterval = null;
        timerOwnerInterval = null;
    }

    function startTimerLoops() {
        stopTimerLoops();
        observeTimerOwnership();
        claimTimerOwnership(true);

        timerInterval = setInterval(() => {
            if (!timerState.session?.isRunning) return;
            renderTimerUi();
        }, 1000);

        timerOwnerInterval = setInterval(() => {
            refreshTimerOwnership();
        }, Math.max(3000, Math.floor(TIMER_OWNER_TTL_MS / 3)));

        timerSyncInterval = setInterval(() => {
            if (!timerState.session?.isRunning || timerState.transitioning) return;

            touchTimerVisibility(Date.now(), { modalOpen: isTimerModalOpen(), persist: true });
            syncRealtimeTimer("heartbeat", {
                activeSession: timerState.session,
                currentSessionTime: getTimerElapsedSeconds(timerState.session),
                userTriggeredWrite: true,
                authorized: true
            }).catch(error => {
                console.error("Timer heartbeat senkronu basarisiz:", error);
            });
        }, TIMER_SYNC_MS);
    }

    function getPendingTimerDelta(session = timerState.session) {
        if (!session) return 0;
        return Math.max(0, getTimerElapsedSeconds(session) - parseInteger(session.lastPersistedElapsedSeconds, 0));
    }

    function getPendingTimerInterval(session = timerState.session, now = Date.now()) {
        if (!session?.isRunning) return null;

        const pendingSeconds = getPendingTimerDelta(session);
        if (pendingSeconds <= 0) return null;

        const normalizedNow = Math.floor(parseInteger(now, Date.now()) / 1000) * 1000;
        const endMs = Math.max(0, normalizedNow);
        const startMs = Math.max(0, endMs - (pendingSeconds * 1000));

        return { startMs, endMs, pendingSeconds };
    }

    function getWindowOverlapSeconds(interval, windowStartMs, windowEndMs) {
        if (!interval || windowEndMs <= windowStartMs) return 0;

        const overlapStart = Math.max(interval.startMs, windowStartMs);
        const overlapEnd = Math.min(interval.endMs, windowEndMs);
        if (overlapEnd <= overlapStart) return 0;

        return Math.max(0, Math.floor((overlapEnd - overlapStart) / 1000));
    }

    function applyPendingTimerDelta(session = timerState.session, now = Date.now()) {
        const interval = getPendingTimerInterval(session, now);
        if (!interval) return 0;

        let cursorMs = interval.startMs;
        let remainingSeconds = interval.pendingSeconds;

        while (remainingSeconds > 0) {
            const cursorDate = new Date(cursorMs);
            const nextDay = new Date(cursorDate);
            nextDay.setHours(24, 0, 0, 0);

            const segmentEndMs = Math.min(interval.endMs, nextDay.getTime());
            let segmentSeconds = Math.floor((segmentEndMs - cursorMs) / 1000);
            if (segmentSeconds <= 0 || segmentSeconds > remainingSeconds) {
                segmentSeconds = remainingSeconds;
            }

            applyStudyDelta(segmentSeconds, cursorDate);
            remainingSeconds -= segmentSeconds;
            cursorMs += segmentSeconds * 1000;
        }

        return interval.pendingSeconds;
    }

    function clampWorkedSecondsForDisplay(rawSeconds, dayDate, now = Date.now()) {
        const safeSeconds = Math.max(0, parseInteger(rawSeconds, 0));
        const dayStart = new Date(dayDate);
        dayStart.setHours(0, 0, 0, 0);
        const nextDay = new Date(dayStart);
        nextDay.setDate(nextDay.getDate() + 1);

        const maxSeconds = now < nextDay.getTime()
            ? Math.max(0, Math.floor((now - dayStart.getTime()) / 1000))
            : 86400;

        return Math.min(safeSeconds, maxSeconds);
    }

    function getRollingSevenDayWindow(nowDate = new Date()) {
        const endDate = new Date(nowDate);
        const todayStart = new Date(nowDate);
        todayStart.setHours(0, 0, 0, 0);
        const startDate = new Date(todayStart);
        startDate.setDate(startDate.getDate() - 6);

        return {
            startDate,
            endDate,
            startMs: startDate.getTime(),
            endMs: endDate.getTime()
        };
    }

    function getRollingSevenDayTotalsFromSchedule(schedule, nowDate = new Date()) {
        const sourceSchedule = schedule || {};
        const nowMs = nowDate.getTime();
        const { startDate } = getRollingSevenDayWindow(nowDate);
        let seconds = 0;
        let questions = 0;

        for (let offset = 0; offset < 7; offset += 1) {
            const dayDate = new Date(startDate);
            dayDate.setDate(dayDate.getDate() + offset);
            const { weekKey, dayIdx } = getCurrentDayMeta(dayDate);
            const dayData = sourceSchedule?.[weekKey]?.[dayIdx];
            if (!dayData) continue;

            seconds += clampWorkedSecondsForDisplay(dayData.workedSeconds, dayDate, nowMs);
            questions += parseInteger(dayData.questions, 0);
        }

        return { seconds, questions };
    }

    function formatTitleRequirementLabel(minAvgHours = 0) {
        if (Math.abs(Number(minAvgHours) - 0.5) < 0.001) return "30 dk";
        if (Number.isInteger(minAvgHours)) return `${minAvgHours} saat`;
        return `${String(minAvgHours).replace(".", ",")} saat`;
    }

    function buildModernTitleLevels() {
        return [
            {
                id: "bronze1",
                minAvgHours: 0.5,
                label: "Bronz I",
                icon: "◈",
                className: "title-bronze-1",
                description: "Düzeni kurdun. Şimdi mesele başlamak değil, bunu her gün yeniden yapabilmek."
            },
            {
                id: "bronze2",
                minAvgHours: 1,
                label: "Bronz II",
                icon: "✦",
                className: "title-bronze-2",
                description: "Temelin oturuyor. Küçük görünen bu tempo, büyük sıçramaların habercisi."
            },
            {
                id: "silver1",
                minAvgHours: 2,
                label: "Gümüş I",
                icon: "◆",
                className: "title-silver-1",
                description: "Çalışma artık ciddiye bindi. Hedefin uzakta değil, her gün biraz daha yakındasın."
            },
            {
                id: "silver2",
                minAvgHours: 3,
                label: "Gümüş II",
                icon: "⬢",
                className: "title-silver-2",
                description: "Ritmin güçlendi. Yorulsan da kopmuyor, masaya oturduğunda farkını hissettiriyorsun."
            },
            {
                id: "gold1",
                minAvgHours: 4,
                label: "Altın I",
                icon: "✧",
                className: "title-gold-1",
                description: "Bu seviye emekle alınır. Disiplinin görünmeye başladı, rakiplerine fark açıyorsun."
            },
            {
                id: "gold2",
                minAvgHours: 5,
                label: "Altın II",
                icon: "✶",
                className: "title-gold-2",
                description: "İstikrarın artık seni taşıyor. Bugünü değil, sonucu değiştirecek seviyeye geldin."
            },
            {
                id: "diamond1",
                minAvgHours: 6,
                label: "Elmas I",
                icon: "✹",
                className: "title-diamond-1",
                description: "Baskı arttığında dağılan değil sertleşen taraftasın. Güçlü öğrenciler burada ayrılır."
            },
            {
                id: "diamond2",
                minAvgHours: 7,
                label: "Elmas II",
                icon: "✺",
                className: "title-diamond-2",
                description: "Süre, sabır ve odak aynı çizgide buluştu. Artık sıradan tempo seni anlatmıyor."
            },
            {
                id: "crown1",
                minAvgHours: 8,
                label: "Taç I",
                icon: "♛",
                className: "title-crown-1",
                description: "Yüksek tempoyu yönetebilen az kişiden birisin. Ciddiyetin artık sadece hissedilmiyor, görülüyor."
            },
            {
                id: "crown2",
                minAvgHours: 9,
                label: "Taç II",
                icon: "♕",
                className: "title-crown-2",
                description: "Zirvenin kapısındasın. Bu seviyeye çıkanlar yarışa katılmaz, yarışın şeklini değiştirir."
            },
            {
                id: "fatih",
                minAvgHours: 10,
                label: "Fatih",
                icon: "♔",
                className: "title-fatih",
                description: "En üst mertebe. Sen artık sadece hedefin peşinden giden değil, onu fetheden kişisin. Bu ünvan, masaya hükmedenlerin ünvanı."
            }
        ].map(level => ({
            ...level,
            requirement: `2 günlük ortalama ${formatTitleRequirementLabel(level.minAvgHours)}`
        }));
    }

    function ensureRollingTwoDayTitleConfig() {
        const nextLevels = buildModernTitleLevels();
        if (typeof TITLE_LEVELS !== "undefined" && Array.isArray(TITLE_LEVELS)) {
            TITLE_LEVELS.splice(0, TITLE_LEVELS.length, ...nextLevels.map(level => ({ ...level })));
            return TITLE_LEVELS;
        }
        return nextLevels;
    }

    function getRollingDayTotalsFromSchedule(schedule, dayCount = 2, nowDate = new Date()) {
        const sourceSchedule = schedule || {};
        const safeDayCount = Math.max(1, parseInteger(dayCount, 2));
        const nowMs = nowDate.getTime();
        const todayStart = new Date(nowDate);
        todayStart.setHours(0, 0, 0, 0);
        let seconds = 0;
        let questions = 0;

        for (let offset = 0; offset < safeDayCount; offset += 1) {
            const dayDate = new Date(todayStart);
            dayDate.setDate(dayDate.getDate() - offset);
            const { weekKey, dayIdx } = getCurrentDayMeta(dayDate);
            const dayData = sourceSchedule?.[weekKey]?.[dayIdx];
            if (!dayData) continue;

            seconds += clampWorkedSecondsForDisplay(dayData.workedSeconds, dayDate, nowMs);
            questions += parseInteger(dayData.questions, 0);
        }

        return {
            seconds,
            questions,
            dayCount: safeDayCount
        };
    }

    function getStoredSelectedTitleId(...sources) {
        for (const source of sources) {
            const nextId = String(
                source?.selectedTitleId
                || source?.selectedTitle
                || source?.preferredTitleId
                || source?.titleInfo?.selectedTitleId
                || ""
            ).trim();
            if (nextId) return nextId;
        }
        return "";
    }

    function parseTimestampMs(value, fallback = 0) {
        if (!value) return fallback;
        if (typeof value?.toMillis === "function") {
            return Math.max(0, parseInteger(value.toMillis(), fallback));
        }
        if (typeof value?.seconds === "number") {
            return Math.max(0, parseInteger(value.seconds * 1000, fallback));
        }

        const numericValue = Number(value);
        if (Number.isFinite(numericValue) && numericValue > 0) {
            return Math.max(0, parseInteger(numericValue, fallback));
        }

        const parsedDate = Date.parse(String(value));
        return Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : fallback;
    }

    function orderTitleAwardMap(awardMap = {}) {
        const orderedMap = {};
        ensureRollingTwoDayTitleConfig().forEach(level => {
            if (!awardMap?.[level.id]) return;
            orderedMap[level.id] = awardMap[level.id];
        });
        return orderedMap;
    }

    function normalizeTitleAwards(rawAwards = {}) {
        const knownIds = new Set(ensureRollingTwoDayTitleConfig().map(level => level.id));
        const normalizedAwards = {};

        Object.entries(rawAwards || {}).forEach(([titleId, rawValue]) => {
            if (!knownIds.has(titleId) || !rawValue || typeof rawValue !== "object") return;

            const awardedAtMs = parseTimestampMs(
                rawValue.awardedAtMs
                || rawValue.awardedAt
                || rawValue.grantedAtMs
                || rawValue.grantedAt,
                0
            );
            const expiresAtMs = parseTimestampMs(
                rawValue.expiresAtMs
                || rawValue.expiresAt
                || rawValue.validUntilMs
                || rawValue.validUntil,
                0
            );

            if (!expiresAtMs) return;

            normalizedAwards[titleId] = {
                awardedAtMs: awardedAtMs || Math.max(0, expiresAtMs - TITLE_VALIDITY_MS),
                expiresAtMs
            };
        });

        return orderTitleAwardMap(normalizedAwards);
    }

    function mergeTitleAwardMaps(...awardSources) {
        const mergedAwards = {};

        awardSources.forEach(source => {
            const normalizedSource = normalizeTitleAwards(source || {});
            Object.entries(normalizedSource).forEach(([titleId, award]) => {
                const existingAward = mergedAwards[titleId];
                if (!existingAward) {
                    mergedAwards[titleId] = { ...award };
                    return;
                }

                mergedAwards[titleId] = {
                    awardedAtMs: existingAward.awardedAtMs && award.awardedAtMs
                        ? Math.min(existingAward.awardedAtMs, award.awardedAtMs)
                        : Math.max(existingAward.awardedAtMs || 0, award.awardedAtMs || 0),
                    expiresAtMs: Math.max(existingAward.expiresAtMs || 0, award.expiresAtMs || 0)
                };
            });
        });

        return orderTitleAwardMap(mergedAwards);
    }

    function getStoredTitleAwards(...sources) {
        const collectedAwards = [];

        sources.forEach(source => {
            if (!source || typeof source !== "object") return;
            if (source.titleAwards) collectedAwards.push(source.titleAwards);
            if (source.titleInfo?.titleAwards) collectedAwards.push(source.titleInfo.titleAwards);
        });

        return mergeTitleAwardMaps(...collectedAwards);
    }

    function areTitleAwardMapsEqual(left = {}, right = {}) {
        const normalizedLeft = normalizeTitleAwards(left);
        const normalizedRight = normalizeTitleAwards(right);
        const leftKeys = Object.keys(normalizedLeft);
        const rightKeys = Object.keys(normalizedRight);

        if (leftKeys.length !== rightKeys.length) return false;

        return leftKeys.every(titleId => (
            normalizedLeft[titleId]?.awardedAtMs === normalizedRight[titleId]?.awardedAtMs
            && normalizedLeft[titleId]?.expiresAtMs === normalizedRight[titleId]?.expiresAtMs
        ));
    }

    function getActiveTitleAwardRecord(source, titleId, referenceMs = Date.now()) {
        if (!titleId) return null;
        const normalizedAwards = source?.titleAwards
            ? normalizeTitleAwards(source.titleAwards)
            : normalizeTitleAwards(source || {});
        const awardRecord = normalizedAwards[titleId];
        return awardRecord?.expiresAtMs > referenceMs ? awardRecord : null;
    }

    function getRemainingTitleLifetimeText(source, titleId, referenceMs = Date.now()) {
        const awardRecord = getActiveTitleAwardRecord(source, titleId, referenceMs);
        if (!awardRecord) return "Açıldığında 7 gün aktif kalır";

        const remainingMs = Math.max(0, awardRecord.expiresAtMs - referenceMs);
        const totalHours = Math.ceil(remainingMs / (60 * 60 * 1000));
        const days = Math.floor(totalHours / 24);
        const hours = totalHours % 24;

        if (days >= 1) {
            return hours ? `${days}g ${hours}s daha aktif` : `${days} gün daha aktif`;
        }
        if (totalHours >= 1) {
            return `${totalHours} saat daha aktif`;
        }

        const minutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)));
        return `${minutes} dk daha aktif`;
    }

    function resolveTitleTimerRecord(profileData = {}) {
        if (profileData?.activeTimer) return profileData.activeTimer;

        const targetUid = String(profileData?.uid || "");
        if (currentUser?.uid && (!targetUid || targetUid === currentUser.uid) && timerState.session) {
            return serializeTimerSession(timerState.session);
        }

        return null;
    }

    function buildResolvedTitleInfo(profileData = {}, referenceDate = new Date()) {
        const titleLevels = ensureRollingTwoDayTitleConfig();
        const safeSchedule = sanitizeScheduleData(profileData?.schedule || {});
        const rollingTotals = getRollingDayTotalsFromSchedule(safeSchedule, 2, referenceDate);
        let totalSeconds = rollingTotals.seconds;
        const timerRecord = resolveTitleTimerRecord(profileData);
        const referenceMs = referenceDate instanceof Date ? referenceDate.getTime() : Date.now();
        const storedSelectedTitleId = getStoredSelectedTitleId(profileData, profileData?.titleInfo || {});
        const storedAwards = getStoredTitleAwards(profileData, profileData?.titleInfo || {});

        if (isTimerRecordRunning(timerRecord)) {
            const interval = getPendingTimerInterval(timerRecord, referenceMs);
            const windowStart = new Date(referenceDate);
            windowStart.setHours(0, 0, 0, 0);
            windowStart.setDate(windowStart.getDate() - 1);
            totalSeconds += getWindowOverlapSeconds(interval, windowStart.getTime(), referenceMs);
        }

        const avgHours = totalSeconds / 3600 / rollingTotals.dayCount;
        const qualifiedTitles = titleLevels.filter(level => avgHours >= level.minAvgHours);
        const activeAwards = {};

        Object.entries(storedAwards).forEach(([titleId, award]) => {
            if ((award?.expiresAtMs || 0) > referenceMs) {
                activeAwards[titleId] = { ...award };
            }
        });

        qualifiedTitles.forEach(level => {
            if (activeAwards[level.id]) return;
            activeAwards[level.id] = {
                awardedAtMs: referenceMs,
                expiresAtMs: referenceMs + TITLE_VALIDITY_MS
            };
        });

        const titleAwards = orderTitleAwardMap(activeAwards);
        const unlockedTitles = titleLevels.filter(level => !!titleAwards[level.id]);
        const defaultTitle = unlockedTitles.length ? unlockedTitles[unlockedTitles.length - 1] : null;
        const selectedTitle = unlockedTitles.find(level => level.id === storedSelectedTitleId) || null;

        return {
            avgHours,
            unlockedTitles,
            qualifiedTitles,
            defaultTitle,
            currentTitle: selectedTitle || defaultTitle,
            selectedTitleId: selectedTitle ? storedSelectedTitleId : "",
            storedSelectedTitleId,
            hasManualSelection: !!selectedTitle,
            evaluationDays: rollingTotals.dayCount,
            validityDays: 7,
            totalSeconds,
            titleAwards
        };
    }

    function ensureTitleSelectionStyles() {
        if (document.getElementById("codex-title-selection-styles")) return;

        const style = document.createElement("style");
        style.id = "codex-title-selection-styles";
        style.textContent = `
            .profile-title-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                margin-bottom: 12px;
                padding: 12px 14px;
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 16px;
                background:
                    linear-gradient(135deg, rgba(255,255,255,0.08), rgba(148,163,184,0.05)),
                    rgba(15, 23, 42, 0.58);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 36px rgba(2, 6, 23, 0.22);
            }
            .profile-title-toolbar-meta {
                font-size: 0.92em;
                opacity: 0.88;
            }
            .profile-title-toolbar-note {
                display: block;
                margin-top: 6px;
                font-size: 0.76em;
                color: rgba(226, 232, 240, 0.72);
            }
            .profile-title-select-btn {
                border: 1px solid rgba(255,255,255,0.16);
                border-radius: 999px;
                padding: 7px 12px;
                background: linear-gradient(135deg, rgba(255,255,255,0.12), rgba(148, 163, 184, 0.08));
                color: #fff;
                cursor: pointer;
                font-size: 0.82em;
                font-weight: 600;
                box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
                transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
            }
            .profile-title-select-btn:hover {
                transform: translateY(-1px);
                background: rgba(96, 165, 250, 0.18);
                border-color: rgba(96, 165, 250, 0.4);
                box-shadow: 0 14px 28px rgba(30, 41, 59, 0.22);
            }
            .profile-title-select-btn.is-active {
                background: linear-gradient(135deg, rgba(34, 197, 94, 0.28), rgba(16, 185, 129, 0.18));
                border-color: rgba(34, 197, 94, 0.42);
                cursor: default;
                box-shadow: 0 12px 28px rgba(21, 128, 61, 0.18);
            }
            .profile-title-default-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 5px 10px;
                border-radius: 999px;
                background: rgba(250, 204, 21, 0.16);
                color: #fde68a;
                border: 1px solid rgba(250, 204, 21, 0.28);
                font-size: 0.75em;
                font-weight: 700;
            }
            .profile-title-expiry-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 5px 10px;
                border-radius: 999px;
                background: rgba(148, 163, 184, 0.14);
                color: #dbeafe;
                border: 1px solid rgba(148, 163, 184, 0.24);
                font-size: 0.72em;
                font-weight: 600;
                letter-spacing: 0.01em;
            }
            .title-card {
                position: relative;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                justify-content: flex-start;
                gap: 10px;
                width: auto !important;
                min-height: 252px !important;
                height: auto !important;
                aspect-ratio: auto !important;
                padding: 18px 16px !important;
                border-radius: 18px;
                border: 1px solid rgba(255,255,255,0.08);
                background:
                    radial-gradient(circle at top left, rgba(255,255,255,0.12), transparent 38%),
                    linear-gradient(160deg, rgba(15, 23, 42, 0.82), rgba(30, 41, 59, 0.58));
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 20px 40px rgba(2, 6, 23, 0.18);
                backdrop-filter: blur(16px);
            }
            .titles-grid {
                grid-template-columns: repeat(auto-fit, minmax(228px, 1fr)) !important;
                justify-content: stretch !important;
                align-items: stretch !important;
            }
            .title-card-header {
                align-items: flex-start;
                flex-wrap: wrap;
                gap: 10px;
            }
            .title-card-header .title-badge {
                flex: 1 1 auto;
                min-width: 0;
            }
            .title-card-header .profile-title-current-pill,
            .title-card-header .profile-title-default-pill {
                flex: 0 0 auto;
                max-width: 100%;
                padding: 4px 8px;
                font-size: 0.64em;
                line-height: 1.2;
                letter-spacing: 0.02em;
                white-space: normal;
                text-transform: none;
            }
            .title-card.unlocked,
            .profile-title-card.current {
                border-color: rgba(255,255,255,0.18);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 24px 44px rgba(15, 23, 42, 0.22);
            }
            .title-card.locked {
                opacity: 0.74;
                filter: saturate(0.76);
            }
            .title-card p,
            .profile-title-card p {
                margin: 0;
                line-height: 1.62;
                white-space: normal !important;
                overflow: visible !important;
                text-overflow: initial !important;
                display: block !important;
                -webkit-line-clamp: unset !important;
                line-clamp: unset !important;
                word-break: break-word;
            }
            .title-card p {
                font-size: 0.84em !important;
            }
            .profile-title-card p {
                font-size: 0.88em !important;
            }
            .title-card-meta,
            .profile-title-expiry {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 7px;
                margin-top: 10px;
                color: rgba(226, 232, 240, 0.76);
                font-size: 0.78em;
            }
            .profile-title-card {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 18px 16px !important;
                border-radius: 18px;
                border: 1px solid rgba(255,255,255,0.08);
                background:
                    radial-gradient(circle at top right, rgba(255,255,255,0.08), transparent 34%),
                    linear-gradient(160deg, rgba(15, 23, 42, 0.78), rgba(30, 41, 59, 0.56));
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 18px 34px rgba(2, 6, 23, 0.16);
            }
            .profile-title-expiry-pill {
                white-space: normal;
            }
            @media (max-width: 720px) {
                .titles-grid {
                    grid-template-columns: 1fr !important;
                }
                .title-card {
                    min-height: 0 !important;
                }
            }
            .title-badge.title-bronze-1,
            .title-badge.title-bronze-2,
            .title-badge.title-silver-1,
            .title-badge.title-silver-2,
            .title-badge.title-gold-1,
            .title-badge.title-gold-2,
            .title-badge.title-diamond-1,
            .title-badge.title-diamond-2,
            .title-badge.title-crown-1,
            .title-badge.title-crown-2,
            .title-badge.title-fatih {
                border-width: 1px;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 10px 22px rgba(15, 23, 42, 0.18);
            }
            .title-badge.title-bronze-1 {
                background: linear-gradient(135deg, rgba(205, 127, 50, 0.26), rgba(120, 53, 15, 0.12));
                color: #f7c89a;
                border-color: rgba(222, 163, 102, 0.34);
            }
            .title-badge.title-bronze-2 {
                background: linear-gradient(135deg, rgba(191, 120, 78, 0.32), rgba(146, 64, 14, 0.18));
                color: #ffd7b1;
                border-color: rgba(234, 179, 125, 0.38);
            }
            .title-badge.title-silver-1 {
                background: linear-gradient(135deg, rgba(226, 232, 240, 0.28), rgba(148, 163, 184, 0.16));
                color: #f8fafc;
                border-color: rgba(203, 213, 225, 0.38);
            }
            .title-badge.title-silver-2 {
                background: linear-gradient(135deg, rgba(226, 232, 240, 0.34), rgba(148, 163, 184, 0.2));
                color: #ffffff;
                border-color: rgba(226, 232, 240, 0.42);
            }
            .title-badge.title-gold-1 {
                background: linear-gradient(135deg, rgba(250, 204, 21, 0.24), rgba(180, 83, 9, 0.16));
                color: #fde68a;
                border-color: rgba(250, 204, 21, 0.34);
            }
            .title-badge.title-gold-2 {
                background: linear-gradient(135deg, rgba(251, 191, 36, 0.3), rgba(217, 119, 6, 0.18));
                color: #fef3c7;
                border-color: rgba(252, 211, 77, 0.42);
            }
            .title-badge.title-diamond-1 {
                background: linear-gradient(135deg, rgba(96, 165, 250, 0.28), rgba(14, 116, 144, 0.16));
                color: #dbeafe;
                border-color: rgba(125, 211, 252, 0.34);
            }
            .title-badge.title-diamond-2 {
                background: linear-gradient(135deg, rgba(56, 189, 248, 0.3), rgba(37, 99, 235, 0.18));
                color: #e0f2fe;
                border-color: rgba(56, 189, 248, 0.4);
            }
            .title-badge.title-crown-1 {
                background: linear-gradient(135deg, rgba(196, 181, 253, 0.28), rgba(124, 58, 237, 0.18));
                color: #ede9fe;
                border-color: rgba(196, 181, 253, 0.4);
            }
            .title-badge.title-crown-2 {
                background: linear-gradient(135deg, rgba(232, 121, 249, 0.28), rgba(126, 34, 206, 0.18));
                color: #fae8ff;
                border-color: rgba(233, 213, 255, 0.42);
            }
            .title-badge.title-fatih {
                background: linear-gradient(135deg, rgba(255, 215, 0, 0.34), rgba(220, 38, 38, 0.2), rgba(126, 34, 206, 0.22));
                color: #fff7cc;
                border-color: rgba(255, 215, 0, 0.5);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 14px 28px rgba(234, 179, 8, 0.18);
            }
        `;
        document.head.appendChild(style);
    }

    function getCurrentWeekQuestionsFromSchedule(schedule, nowDate = new Date()) {
        const sourceSchedule = schedule || {};
        const currentWeekKey = typeof getWeekKey === "function" ? getWeekKey(nowDate) : "";
        let questions = 0;

        if (!currentWeekKey || !sourceSchedule[currentWeekKey]) return 0;

        for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
            questions += parseInteger(ensureDayObject(sourceSchedule[currentWeekKey]?.[dayIdx] || {}).questions, 0);
        }

        return questions;
    }

    function getCurrentDayQuestionsFromSchedule(schedule, referenceDate = new Date()) {
        const sourceSchedule = schedule || {};
        const { weekKey, dayIdx } = getCurrentDayMeta(referenceDate);
        return parseInteger(ensureDayObject(sourceSchedule?.[weekKey]?.[dayIdx] || {}).questions, 0);
    }

    function getExplicitQuestionCounterValue(userData = {}, fieldNames = []) {
        return fieldNames.reduce((maxValue, fieldName) => {
            const nextValue = parseInteger(userData?.[fieldName], 0);
            return Math.max(maxValue, nextValue);
        }, 0);
    }

    function buildQuestionCounterPayload(schedule, referenceDate = new Date()) {
        const safeSchedule = sanitizeScheduleData(schedule || {});
        const dailyQuestions = getCurrentDayQuestionsFromSchedule(safeSchedule, referenceDate);
        const weeklyQuestions = getCurrentWeekQuestionsFromSchedule(safeSchedule, referenceDate);

        return {
            daily: dailyQuestions,
            weekly: weeklyQuestions,
            dailyQuestions,
            weeklyQuestions,
            dailyQuestionCount: dailyQuestions,
            weeklyQuestionCount: weeklyQuestions
        };
    }

    function getCurrentDayWorkedSecondsFromSchedule(schedule, referenceDate = new Date()) {
        const { weekKey, dayIdx } = getCurrentDayMeta(referenceDate);
        const dayData = ensureDayObject(schedule?.[weekKey]?.[dayIdx] || {});
        return clampWorkedSecondsForDisplay(dayData.workedSeconds, referenceDate, Date.now());
    }

    function isDailyStudySnapshotFresh(userData = {}, referenceDate = new Date()) {
        const currentMeta = getCurrentDayMeta(referenceDate);
        const explicitDateKey = String(
            userData?.dailyStudyDateKey
            || userData?.todayDateKey
            || ""
        ).trim();
        if (explicitDateKey) {
            return explicitDateKey === currentMeta.dateKey;
        }

        const lastTimerSyncAt = Math.max(
            parseInteger(userData?.lastTimerSyncAt, 0),
            parseInteger(userData?.updatedAtMs, 0),
            parseInteger(userData?.updatedAt, 0)
        );
        if (lastTimerSyncAt <= 0) return false;

        const dayStart = new Date(referenceDate);
        dayStart.setHours(0, 0, 0, 0);
        return lastTimerSyncAt >= dayStart.getTime();
    }

    function getDailySnapshotResetState(userData = {}, referenceDate = new Date()) {
        const safeData = userData && typeof userData === "object" ? userData : {};
        const currentMeta = getCurrentDayMeta(referenceDate);
        const explicitDateKey = String(
            safeData?.dailyStudyDateKey
            || safeData?.todayDateKey
            || ""
        ).trim();
        const scheduleSeconds = getCurrentDayWorkedSecondsFromSchedule(safeData.schedule || {}, referenceDate);
        const explicitDailySeconds = Math.max(
            parseInteger(safeData?.dailyStudyTime, 0),
            parseInteger(safeData?.todayStudyTime, 0),
            parseInteger(safeData?.todayWorkedSeconds, 0)
        );
        const hasVisibleActiveTimer = isTimerVisibleForLeaderboard(safeData?.activeTimer, referenceDate.getTime());
        const liveSessionSnapshot = getLeaderboardLiveSessionSnapshot(safeData, referenceDate.getTime());
        const hasVisibleLiveSession = hasVisibleActiveTimer || liveSessionSnapshot.isLive;
        const isFreshSnapshot = isDailyStudySnapshotFresh(safeData, referenceDate);
        const shouldReset = !hasVisibleLiveSession && (
            !isFreshSnapshot
            || (!explicitDateKey && explicitDailySeconds > scheduleSeconds && scheduleSeconds <= 0)
        );

        if (!shouldReset) {
            return {
                normalizedData: safeData,
                needsSync: false
            };
        }

        const normalizedDailySeconds = scheduleSeconds;
        const normalizedData = {
            ...safeData,
            dailyStudyTime: normalizedDailySeconds,
            todayStudyTime: normalizedDailySeconds,
            todayWorkedSeconds: normalizedDailySeconds,
            currentSessionTime: 0,
            activeTimer: null,
            isWorking: false,
            dailyStudyDateKey: currentMeta.dateKey,
            todayDateKey: currentMeta.dateKey
        };
        const needsSync = (
            parseInteger(safeData?.dailyStudyTime, 0) !== normalizedDailySeconds
            || parseInteger(safeData?.todayStudyTime, 0) !== normalizedDailySeconds
            || parseInteger(safeData?.todayWorkedSeconds, 0) !== normalizedDailySeconds
            || parseInteger(safeData?.currentSessionTime, 0) !== 0
            || !!safeData?.activeTimer
            || !!safeData?.isWorking
            || explicitDateKey !== currentMeta.dateKey
        );

        return {
            normalizedData,
            needsSync
        };
    }

    function queueAutoDailyResetSync(referenceDate = new Date()) {
        if (!currentUser?.uid) return false;

        const signature = `${currentUser.uid}:${getCurrentDayMeta(referenceDate).dateKey}`;
        if (lastAutoDailyResetSyncSignature === signature) {
            return false;
        }
        lastAutoDailyResetSyncSignature = signature;

        setTimeout(() => {
            saveData({ authorized: true, immediate: true });
        }, 0);

        return true;
    }

    function getFreshDailyStudySeconds(userData = {}, schedule = {}, referenceDate = new Date()) {
        const resetState = getDailySnapshotResetState({
            ...(userData || {}),
            schedule: sanitizeScheduleData(schedule || userData?.schedule || {})
        }, referenceDate);
        const scheduleSeconds = getCurrentDayWorkedSecondsFromSchedule(resetState.normalizedData.schedule || {}, referenceDate);
        if (!isDailyStudySnapshotFresh(resetState.normalizedData, referenceDate)) {
            return scheduleSeconds;
        }

        return Math.max(
            scheduleSeconds,
            parseInteger(resetState.normalizedData?.dailyStudyTime, 0),
            parseInteger(resetState.normalizedData?.todayStudyTime, 0),
            parseInteger(resetState.normalizedData?.todayWorkedSeconds, 0)
        );
    }

    function getFirstNonEmptyArray(...sources) {
        for (const source of sources) {
            if (Array.isArray(source) && source.length) return [...source];
        }
        return [];
    }

    function getMostInformativeProfileSchedule(...scheduleCandidates) {
        let fallbackSchedule = {};

        for (const candidate of scheduleCandidates) {
            const safeSchedule = sanitizeScheduleData(candidate || {});
            if (!Object.keys(fallbackSchedule).length) {
                fallbackSchedule = safeSchedule;
            }
            if (hasAnyScheduleEntries(safeSchedule)) {
                return safeSchedule;
            }
        }

        return fallbackSchedule;
    }

    function getProfileQuestionSummary(profileData = {}, referenceDate = new Date()) {
        const safeSchedule = sanitizeScheduleData(profileData?.schedule || {});
        const dailyQuestions = Math.max(
            getCurrentDayQuestionsFromSchedule(safeSchedule, referenceDate),
            getExplicitQuestionCounterValue(profileData || {}, ["leaderboardDailyQuestions", "dailyQuestionCount", "dailyQuestions", "daily"])
        );
        const weeklyQuestions = Math.max(
            getCurrentWeekQuestionsFromSchedule(safeSchedule, referenceDate),
            getExplicitQuestionCounterValue(profileData || {}, ["leaderboardWeeklyQuestions", "weeklyQuestionCount", "weeklyQuestions", "weekly"]),
            dailyQuestions
        );
        const totalQuestionsAllTime = Math.max(
            getExplicitQuestionCounterValue(profileData || {}, ["totalQuestionsAllTime", "totalQuestions", "questionCount", "total"]),
            dailyQuestions,
            weeklyQuestions,
            typeof calculateTotalQuestionsFromSchedule === "function"
                ? calculateTotalQuestionsFromSchedule(safeSchedule)
                : 0
        );

        return {
            schedule: safeSchedule,
            dailyQuestions,
            weeklyQuestions,
            totalQuestionsAllTime,
            daily: dailyQuestions,
            weekly: weeklyQuestions,
            total: totalQuestionsAllTime,
            dailyQuestionCount: dailyQuestions,
            weeklyQuestionCount: weeklyQuestions
        };
    }

    function buildProfileModalPayload({
        uid = "",
        baseProfile = {},
        userProfile = {},
        publicProfile = {},
        cachedProfile = {},
        editable = false,
        referenceDate = new Date()
    } = {}) {
        const safeBase = baseProfile && typeof baseProfile === "object" ? baseProfile : {};
        const safeUser = userProfile && typeof userProfile === "object" ? userProfile : {};
        const safePublic = publicProfile && typeof publicProfile === "object" ? publicProfile : {};
        const safeCached = cachedProfile && typeof cachedProfile === "object" ? cachedProfile : {};
        const resolvedSchedule = editable
            ? getMostInformativeProfileSchedule(
                scheduleData,
                safeBase.schedule,
                safeUser.schedule,
                safePublic.schedule,
                safeCached.schedule
            )
            : getMostInformativeProfileSchedule(
                safeUser.schedule,
                safePublic.schedule,
                safeCached.schedule,
                safeBase.schedule
            );
        const questionSummary = getProfileQuestionSummary({
            schedule: resolvedSchedule,
            leaderboardDailyQuestions: Math.max(
                parseInteger(safeBase.leaderboardDailyQuestions, 0),
                parseInteger(safeUser.leaderboardDailyQuestions, 0),
                parseInteger(safePublic.leaderboardDailyQuestions, 0),
                parseInteger(safeCached.leaderboardDailyQuestions, 0)
            ),
            dailyQuestionCount: Math.max(
                parseInteger(safeBase.dailyQuestionCount, 0),
                parseInteger(safeUser.dailyQuestionCount, 0),
                parseInteger(safePublic.dailyQuestionCount, 0),
                parseInteger(safeCached.dailyQuestionCount, 0)
            ),
            dailyQuestions: Math.max(
                parseInteger(safeBase.dailyQuestions, 0),
                parseInteger(safeUser.dailyQuestions, 0),
                parseInteger(safePublic.dailyQuestions, 0),
                parseInteger(safeCached.dailyQuestions, 0),
                editable ? getCurrentDayQuestionsFromSchedule(scheduleData || {}, referenceDate) : 0
            ),
            daily: Math.max(
                parseInteger(safeBase.daily, 0),
                parseInteger(safeUser.daily, 0),
                parseInteger(safePublic.daily, 0),
                parseInteger(safeCached.daily, 0)
            ),
            leaderboardWeeklyQuestions: Math.max(
                parseInteger(safeBase.leaderboardWeeklyQuestions, 0),
                parseInteger(safeUser.leaderboardWeeklyQuestions, 0),
                parseInteger(safePublic.leaderboardWeeklyQuestions, 0),
                parseInteger(safeCached.leaderboardWeeklyQuestions, 0)
            ),
            weeklyQuestionCount: Math.max(
                parseInteger(safeBase.weeklyQuestionCount, 0),
                parseInteger(safeUser.weeklyQuestionCount, 0),
                parseInteger(safePublic.weeklyQuestionCount, 0),
                parseInteger(safeCached.weeklyQuestionCount, 0)
            ),
            weeklyQuestions: Math.max(
                parseInteger(safeBase.weeklyQuestions, 0),
                parseInteger(safeUser.weeklyQuestions, 0),
                parseInteger(safePublic.weeklyQuestions, 0),
                parseInteger(safeCached.weeklyQuestions, 0),
                editable && typeof getCurrentWeekQuestionsFromSchedule === "function"
                    ? getCurrentWeekQuestionsFromSchedule(scheduleData || {}, referenceDate)
                    : 0
            ),
            weekly: Math.max(
                parseInteger(safeBase.weekly, 0),
                parseInteger(safeUser.weekly, 0),
                parseInteger(safePublic.weekly, 0),
                parseInteger(safeCached.weekly, 0)
            ),
            totalQuestionsAllTime: Math.max(
                parseInteger(safeBase.totalQuestionsAllTime, 0),
                parseInteger(safeUser.totalQuestionsAllTime, 0),
                parseInteger(safePublic.totalQuestionsAllTime, 0),
                parseInteger(safeCached.totalQuestionsAllTime, 0),
                editable ? parseInteger(totalQuestionsAllTime, 0) : 0
            ),
            totalQuestions: Math.max(
                parseInteger(safeBase.totalQuestions, 0),
                parseInteger(safeUser.totalQuestions, 0),
                parseInteger(safePublic.totalQuestions, 0),
                parseInteger(safeCached.totalQuestions, 0)
            ),
            questionCount: Math.max(
                parseInteger(safeBase.questionCount, 0),
                parseInteger(safeUser.questionCount, 0),
                parseInteger(safePublic.questionCount, 0),
                parseInteger(safeCached.questionCount, 0)
            ),
            total: Math.max(
                parseInteger(safeBase.total, 0),
                parseInteger(safeUser.total, 0),
                parseInteger(safePublic.total, 0),
                parseInteger(safeCached.total, 0)
            )
        }, referenceDate);
        const resolvedUsername = String(
            safeBase.username
            || safeUser.username
            || safePublic.username
            || safeCached.username
            || (editable ? currentUsername : "")
            || safeBase.email?.split?.("@")?.[0]
            || safeUser.email?.split?.("@")?.[0]
            || safePublic.email?.split?.("@")?.[0]
            || safeCached.email?.split?.("@")?.[0]
            || ""
        ).trim();
        const resolvedEmail = String(
            safeBase.email
            || safeUser.email
            || safePublic.email
            || safeCached.email
            || (editable ? (currentUser?.email || "") : "")
            || ""
        ).trim();
        const resolvedStudyTrack = String(
            safeBase.studyTrack
            || safeUser.studyTrack
            || safePublic.studyTrack
            || safeCached.studyTrack
            || (editable ? studyTrack : "")
            || ""
        ).trim();
        const resolvedSelectedSubjects = typeof normalizeSelectedSubjects === "function"
            ? normalizeSelectedSubjects(
                resolvedStudyTrack,
                getFirstNonEmptyArray(
                    safeBase.selectedSubjects,
                    safeUser.selectedSubjects,
                    safePublic.selectedSubjects,
                    safeCached.selectedSubjects,
                    editable ? selectedSubjects : []
                )
            )
            : getFirstNonEmptyArray(
                safeBase.selectedSubjects,
                safeUser.selectedSubjects,
                safePublic.selectedSubjects,
                safeCached.selectedSubjects,
                editable ? selectedSubjects : []
            );
        const totalWorkedSeconds = Math.max(
            parseInteger(safeBase.totalWorkedSeconds, 0),
            parseInteger(safeBase.totalStudyTime, 0),
            parseInteger(safeUser.totalWorkedSeconds, 0),
            parseInteger(safeUser.totalStudyTime, 0),
            parseInteger(safePublic.totalWorkedSeconds, 0),
            parseInteger(safePublic.totalStudyTime, 0),
            parseInteger(safeCached.totalWorkedSeconds, 0),
            parseInteger(safeCached.totalStudyTime, 0),
            editable ? parseInteger(totalWorkedSecondsAllTime, 0) : 0,
            typeof calculateTotalWorkedSecondsFromSchedule === "function"
                ? calculateTotalWorkedSecondsFromSchedule(resolvedSchedule)
                : 0
        );
        const currentWeekSeconds = Math.max(
            parseInteger(safeBase.currentWeekSeconds, 0),
            parseInteger(safeBase.weeklyStudyTime, 0),
            parseInteger(safeUser.currentWeekSeconds, 0),
            parseInteger(safeUser.weeklyStudyTime, 0),
            parseInteger(safePublic.currentWeekSeconds, 0),
            parseInteger(safePublic.weeklyStudyTime, 0),
            parseInteger(safeCached.currentWeekSeconds, 0),
            parseInteger(safeCached.weeklyStudyTime, 0),
            editable && typeof getCurrentWeekTotalsFromSchedule === "function"
                ? getCurrentWeekTotalsFromSchedule(scheduleData || {}).seconds
                : 0,
            typeof getCurrentWeekTotalsFromSchedule === "function"
                ? getCurrentWeekTotalsFromSchedule(resolvedSchedule).seconds
                : 0
        );
        const resolvedNotesSource = editable
            ? (safeBase.notes || safeUser.notes || userNotes || [])
            : (safeBase.notes || safePublic.notes || safeCached.notes || safeUser.notes || []);
        const resolvedSelectedTitleId = getStoredSelectedTitleId(
            safeBase,
            safeUser,
            safePublic,
            safeCached,
            editable ? (currentUserLiveDoc || {}) : {}
        );
        const resolvedTitleAwards = getStoredTitleAwards(
            safeBase,
            safeUser,
            safePublic,
            safeCached,
            editable ? (currentUserLiveDoc || {}) : {}
        );
        const resolvedActiveTimer = safeBase.activeTimer
            || safeUser.activeTimer
            || safePublic.activeTimer
            || safeCached.activeTimer
            || (editable && timerState.session ? serializeTimerSession(timerState.session) : null);
        const resolvedIsAdmin = typeof safeBase.isAdmin === "boolean"
            ? safeBase.isAdmin
            : !!safeUser.isAdmin
                || !!safePublic.isAdmin
                || !!safeCached.isAdmin
                || (typeof isAdminIdentity === "function" && isAdminIdentity(resolvedUsername || "", resolvedEmail || ""));
        const resolvedUid = String(uid || safeBase.uid || safeUser.uid || safePublic.uid || safeCached.uid || (editable ? (currentUser?.uid || "") : ""));
        const resolvedTitleInfo = buildResolvedTitleInfo({
            uid: resolvedUid,
            schedule: resolvedSchedule,
            activeTimer: resolvedActiveTimer,
            selectedTitleId: resolvedSelectedTitleId,
            titleAwards: resolvedTitleAwards
        }, referenceDate);

        return {
            uid: resolvedUid,
            username: resolvedUsername || "Kullanici",
            email: resolvedEmail,
            isAdmin: resolvedIsAdmin,
            about: String(
                safeBase.about
                || safeUser.about
                || safePublic.about
                || safeCached.about
                || (editable ? currentProfileAbout : "")
                || ""
            ).trim(),
            profileImage: safeBase.profileImage
                || safeUser.profileImage
                || safePublic.profileImage
                || safeCached.profileImage
                || (editable ? currentProfileImage : "")
                || "",
            accountCreatedAt: safeBase.accountCreatedAt
                || safeUser.accountCreatedAt
                || safePublic.accountCreatedAt
                || safeCached.accountCreatedAt
                || (editable ? currentAccountCreatedAt : "")
                || "",
            studyTrack: resolvedStudyTrack,
            selectedSubjects: resolvedSelectedSubjects,
            schedule: resolvedSchedule,
            selectedTitleId: resolvedTitleInfo.selectedTitleId,
            titleAwards: resolvedTitleInfo.titleAwards,
            totalWorkedSeconds,
            totalStudyTime: totalWorkedSeconds,
            currentWeekSeconds,
            weeklyStudyTime: currentWeekSeconds,
            activeTimer: resolvedActiveTimer,
            notes: editable
                ? (typeof normalizeUserNotes === "function" ? normalizeUserNotes(resolvedNotesSource) : resolvedNotesSource)
                : (typeof getPublicUserNotes === "function" ? getPublicUserNotes(resolvedNotesSource) : []),
            titleInfo: resolvedTitleInfo,
            ...questionSummary
        };
    }

    function ensureProfileQuestionStatCards() {
        const grid = document.querySelector("#profile-modal .profile-stats-grid");
        if (!grid) return;

        [
            { id: "profile-daily-questions", label: "Bugün Çözülen" },
            { id: "profile-weekly-questions", label: "Bu Hafta Çözülen" }
        ].forEach(cardConfig => {
            if (document.getElementById(cardConfig.id)) return;

            const card = document.createElement("div");
            card.className = "profile-stat-card";
            card.innerHTML = `<span>${cardConfig.label}</span><strong id="${cardConfig.id}">0</strong>`;
            grid.appendChild(card);
        });
    }

    function applyProfileStatsToModal(profileData = {}) {
        ensureProfileQuestionStatCards();

        const questionSummary = getProfileQuestionSummary(profileData);
        const totalWorkedSeconds = Math.max(
            parseInteger(profileData.totalWorkedSeconds, 0),
            parseInteger(profileData.totalStudyTime, 0),
            typeof calculateTotalWorkedSecondsFromSchedule === "function"
                ? calculateTotalWorkedSecondsFromSchedule(profileData.schedule || {})
                : 0
        );
        const titleInfo = profileData.titleInfo || buildResolvedTitleInfo(profileData);

        const totalWorkNode = document.getElementById("profile-total-work");
        if (totalWorkNode) {
            totalWorkNode.innerText = typeof formatSeconds === "function"
                ? formatSeconds(totalWorkedSeconds)
                : String(totalWorkedSeconds);
        }

        const totalQuestionsNode = document.getElementById("profile-total-questions");
        if (totalQuestionsNode) totalQuestionsNode.innerText = questionSummary.totalQuestionsAllTime || 0;

        const dailyQuestionsNode = document.getElementById("profile-daily-questions");
        if (dailyQuestionsNode) dailyQuestionsNode.innerText = questionSummary.dailyQuestions || 0;

        const weeklyQuestionsNode = document.getElementById("profile-weekly-questions");
        if (weeklyQuestionsNode) weeklyQuestionsNode.innerText = questionSummary.weeklyQuestions || 0;

        const titleWrapper = document.getElementById("profile-title-wrapper");
        if (titleWrapper && titleInfo && typeof getTitleBadgeHtml === "function") {
            titleWrapper.innerHTML = `${getTitleBadgeHtml(titleInfo)}<span class="profile-title-meta">2 günlük ortalama: ${(Number(titleInfo.avgHours) || 0).toFixed(1)} saat • ünvanlar 7 gün aktif</span>`;
        }

        return {
            ...profileData,
            totalWorkedSeconds,
            totalStudyTime: totalWorkedSeconds,
            titleInfo,
            ...questionSummary
        };
    }

    function refreshVisibleProfileModalFromLiveData() {
        const modal = document.getElementById("profile-modal");
        if (!modal || modal.style.display !== "flex" || !currentProfileModalData) return;

        const currentUid = String(currentProfileModalData.uid || "");
        const resolvedProfile = currentProfileModalEditable
            ? buildProfileModalPayload({
                uid: currentUid,
                baseProfile: currentProfileModalData || {},
                userProfile: currentUserLiveDoc || {},
                editable: true
            })
            : buildProfileModalPayload({
                uid: currentUid,
                baseProfile: currentProfileModalData || {},
                cachedProfile: currentUid ? (leaderboardUserProfiles[currentUid] || {}) : {},
                editable: false
            });
        const syncedProfile = applyProfileStatsToModal(resolvedProfile);

        if (typeof currentProfileModalData !== "undefined") {
            currentProfileModalData = {
                ...(currentProfileModalData || {}),
                ...syncedProfile,
                notes: resolvedProfile.notes
            };
        }
    }

    function buildEditableProfilePayload(selectedTitleIdOverride) {
        return buildProfileModalPayload({
            uid: currentUser?.uid || "",
            editable: true,
            userProfile: currentUserLiveDoc || {},
            baseProfile: {
                ...(currentProfileModalData || {}),
                username: currentUsername,
                email: currentUser?.email || "",
                isAdmin: typeof isCurrentAdmin === "function" ? isCurrentAdmin() : false,
                about: currentProfileAbout,
                profileImage: currentProfileImage,
                totalWorkedSeconds: totalWorkedSecondsAllTime,
                totalStudyTime: totalWorkedSecondsAllTime,
                totalQuestionsAllTime: totalQuestionsAllTime,
                accountCreatedAt: currentAccountCreatedAt,
                studyTrack: studyTrack,
                selectedSubjects: selectedSubjects,
                notes: typeof normalizeUserNotes === "function" ? normalizeUserNotes(userNotes) : (userNotes || []),
                schedule: scheduleData,
                activeTimer: timerState.session ? serializeTimerSession(timerState.session) : null,
                selectedTitleId: selectedTitleIdOverride === undefined
                    ? getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {})
                    : selectedTitleIdOverride,
                titleAwards: getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {})
            }
        });
    }

    function applyProfileTitleSelection(nextTitleId = "") {
        if (!currentUser || !currentProfileModalEditable) return;

        const normalizedTitleId = String(nextTitleId || "").trim();
        const previewProfile = buildEditableProfilePayload(normalizedTitleId);
        const unlockedIds = new Set((previewProfile.titleInfo?.unlockedTitles || []).map(level => level.id));
        const resolvedTitleId = normalizedTitleId && unlockedIds.has(normalizedTitleId) ? normalizedTitleId : "";

        currentUserLiveDoc = {
            ...(currentUserLiveDoc || {}),
            selectedTitleId: resolvedTitleId,
            titleAwards: previewProfile.titleInfo?.titleAwards || getStoredTitleAwards(currentUserLiveDoc || {})
        };
        if (typeof currentProfileModalData !== "undefined") {
            currentProfileModalData = {
                ...(currentProfileModalData || {}),
                selectedTitleId: resolvedTitleId,
                titleAwards: previewProfile.titleInfo?.titleAwards || getStoredTitleAwards(currentProfileModalData || {})
            };
        }

        const refreshedProfile = buildEditableProfilePayload(resolvedTitleId);
        showProfileModal(refreshedProfile, true);
        refreshLeaderboardOptimistically();

        const syncPayload = {
            ...(typeof buildUserPayload === "function" ? buildUserPayload() : {}),
            selectedTitleId: resolvedTitleId,
            titleAwards: refreshedProfile.titleInfo?.titleAwards || {},
            schedule: scheduleData,
            activeTimer: timerState.session ? serializeTimerSession(timerState.session) : null
        };

        syncPublicProfileSnapshotSafely(syncPayload);
        syncLeaderboardSnapshotSafely(syncPayload);
        saveData({ authorized: true, immediate: true });

        if (document.getElementById("titles-modal")?.style.display === "flex" && typeof renderTitlesModal === "function") {
            renderTitlesModal();
        }

        safeShowAlert(
            resolvedTitleId ? "Aktif ünvan güncellendi." : "Varsayılan ünvan yeniden kullanılıyor.",
            "success"
        );
    }

    window.selectProfileTitle = function(titleId) {
        applyProfileTitleSelection(titleId);
    };

    window.resetProfileTitleSelection = function() {
        applyProfileTitleSelection("");
    };

    function syncCurrentUserTitleAwardsIfNeeded(options = {}) {
        if (!currentUser?.uid) return false;

        const activeTimerRecord = timerState.session ? serializeTimerSession(timerState.session) : null;
        const titleInfo = buildResolvedTitleInfo({
            uid: currentUser.uid,
            schedule: scheduleData || {},
            activeTimer: activeTimerRecord,
            selectedTitleId: getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {}),
            titleAwards: getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {})
        });
        const nextSelectedTitleId = titleInfo.selectedTitleId || "";
        const nextTitleAwards = titleInfo.titleAwards || {};
        const currentSelectedTitleId = getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {});
        const currentTitleAwards = getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {});

        if (
            nextSelectedTitleId === currentSelectedTitleId
            && areTitleAwardMapsEqual(nextTitleAwards, currentTitleAwards)
        ) {
            return false;
        }

        currentUserLiveDoc = {
            ...(currentUserLiveDoc || {}),
            selectedTitleId: nextSelectedTitleId,
            titleAwards: nextTitleAwards
        };

        if (currentProfileModalEditable && typeof currentProfileModalData !== "undefined") {
            currentProfileModalData = {
                ...(currentProfileModalData || {}),
                selectedTitleId: nextSelectedTitleId,
                titleAwards: nextTitleAwards,
                titleInfo
            };
        }

        if (options.persist === false) return true;

        const syncPayload = {
            ...(typeof buildUserPayload === "function" ? buildUserPayload() : {}),
            selectedTitleId: nextSelectedTitleId,
            titleAwards: nextTitleAwards,
            schedule: scheduleData,
            activeTimer: activeTimerRecord
        };

        syncPublicProfileSnapshotSafely(syncPayload);
        syncLeaderboardSnapshotSafely(syncPayload);
        saveData({ authorized: true, immediate: true });
        return true;
    }

    function isCurrentUserPayloadTarget(basePayload = {}) {
        const targetUid = String(basePayload?.uid || "");
        if (!currentUser?.uid) return !targetUid;
        return !targetUid || targetUid === currentUser.uid;
    }

    function buildPublicProfilePayload(basePayload = {}) {
        const safeSchedule = sanitizeScheduleData(basePayload.schedule || scheduleData || {});
        const currentDayMeta = getCurrentDayMeta(new Date());
        const questionCounters = buildQuestionCounterPayload(safeSchedule);
        const resolvedSelectedTitleId = getStoredSelectedTitleId(basePayload, currentUserLiveDoc || {});
        const resolvedTitleAwards = getStoredTitleAwards(basePayload, currentUserLiveDoc || {});
        const weeklyStudyTime = typeof getCurrentWeekTotalsFromSchedule === "function"
            ? getCurrentWeekTotalsFromSchedule(safeSchedule).seconds
            : parseInteger(basePayload.currentWeekSeconds, 0);
        const activeTimer = basePayload.activeTimer || (timerState.session ? serializeTimerSession(timerState.session) : null);
        const legacyWorkingStartedAt = Math.max(
            parseInteger(basePayload.legacyWorkingStartedAt, 0),
            activeTimer
                ? Math.max(
                    parseInteger(activeTimer.startedAtMs, 0),
                    Date.now() - (Math.max(0, parseInteger(basePayload.currentSessionTime, 0)) * 1000)
                )
                : 0
        );
        const publicNotes = typeof getPublicUserNotes === "function"
            ? getPublicUserNotes(basePayload.notes || userNotes || [])
            : [];
        const resolvedUsername = String(
            currentUsername
            || basePayload.username
            || currentUser?.displayName
            || currentUser?.email?.split("@")[0]
            || basePayload.email?.split?.("@")?.[0]
            || ""
        ).trim();
        const resolvedTitleInfo = buildResolvedTitleInfo({
            uid: currentUser?.uid || basePayload.uid || "",
            schedule: safeSchedule,
            activeTimer,
            selectedTitleId: resolvedSelectedTitleId,
            titleAwards: resolvedTitleAwards
        });

        return {
            uid: currentUser?.uid || basePayload.uid || "",
            username: resolvedUsername || "Kullanici",
            about: currentProfileAbout || basePayload.about || "",
            profileImage: currentProfileImage || basePayload.profileImage || "",
            accountCreatedAt: currentAccountCreatedAt || basePayload.accountCreatedAt || "",
            studyTrack: studyTrack || basePayload.studyTrack || "",
            selectedSubjects: typeof normalizeSelectedSubjects === "function"
                ? normalizeSelectedSubjects(studyTrack || basePayload.studyTrack || "", selectedSubjects?.length ? selectedSubjects : (basePayload.selectedSubjects || []))
                : (selectedSubjects?.length ? selectedSubjects : (basePayload.selectedSubjects || [])),
            selectedTitleId: resolvedTitleInfo.selectedTitleId,
            titleAwards: resolvedTitleInfo.titleAwards,
            isAdmin: typeof isCurrentAdmin === "function" ? isCurrentAdmin() : !!basePayload.isAdmin,
            role: basePayload.role || ((typeof isCurrentAdmin === "function" && isCurrentAdmin()) ? "admin" : "user"),
            adminTitle: basePayload.adminTitle || "",
            totalWorkedSeconds: Math.max(
                parseInteger(basePayload.totalWorkedSeconds, 0),
                parseInteger(basePayload.totalStudyTime, 0),
                typeof calculateTotalWorkedSecondsFromSchedule === "function"
                    ? calculateTotalWorkedSecondsFromSchedule(safeSchedule)
                    : 0
            ),
            totalStudyTime: Math.max(
                parseInteger(basePayload.totalStudyTime, 0),
                parseInteger(basePayload.totalWorkedSeconds, 0)
            ),
            totalQuestionsAllTime: Math.max(
                parseInteger(basePayload.totalQuestionsAllTime, 0),
                typeof calculateTotalQuestionsFromSchedule === "function"
                    ? calculateTotalQuestionsFromSchedule(safeSchedule)
                    : 0
            ),
            dailyStudyTime: Math.max(
                getFreshDailyStudySeconds(basePayload, safeSchedule),
                getCurrentDayWorkedSeconds()
            ),
            dailyStudyDateKey: currentDayMeta.dateKey,
            weeklyStudyTime,
            currentWeekSeconds: weeklyStudyTime,
            currentSessionTime: parseInteger(basePayload.currentSessionTime, 0),
            legacyWorkingStartedAt,
            activeTimer,
            isWorking: !!basePayload.isWorking
                || isTimerVisibleForLeaderboard(basePayload.activeTimer)
                || isTimerVisibleForLeaderboard(timerState.session),
            lastTimerSyncAt: parseInteger(basePayload.lastTimerSyncAt, Date.now()),
            notes: publicNotes,
            ...questionCounters
        };
    }

    function buildLeaderboardDocumentPayload(basePayload = {}) {
        const isCurrentUserTarget = isCurrentUserPayloadTarget(basePayload);
        const safeSchedule = sanitizeScheduleData(basePayload.schedule || (isCurrentUserTarget ? (scheduleData || {}) : {}));
        const currentDayMeta = getCurrentDayMeta(new Date());
        const questionCounters = buildQuestionCounterPayload(safeSchedule);
        const resolvedSelectedTitleId = getStoredSelectedTitleId(basePayload, isCurrentUserTarget ? (currentUserLiveDoc || {}) : {});
        const resolvedTitleAwards = getStoredTitleAwards(basePayload, isCurrentUserTarget ? (currentUserLiveDoc || {}) : {});
        const resolvedEmail = String(
            (isCurrentUserTarget ? (currentUser?.email || "") : "")
            || basePayload.email
            || ""
        ).trim();
        const resolvedUsername = String(
            (isCurrentUserTarget ? (currentUsername || "") : "")
            || basePayload.username
            || (isCurrentUserTarget ? (currentUser?.displayName || "") : "")
            || resolvedEmail.split("@")[0]
            || ""
        ).trim();
        const resolvedStudyTrack = String(
            (isCurrentUserTarget ? (studyTrack || "") : "")
            || basePayload.studyTrack
            || ""
        ).trim();
        const resolvedSelectedSubjectsSource = isCurrentUserTarget && Array.isArray(selectedSubjects) && selectedSubjects.length
            ? selectedSubjects
            : (basePayload.selectedSubjects || []);
        const resolvedSelectedSubjects = typeof normalizeSelectedSubjects === "function"
            ? normalizeSelectedSubjects(resolvedStudyTrack, resolvedSelectedSubjectsSource)
            : resolvedSelectedSubjectsSource;
        const derivedAdminMeta = typeof getAdminProfileMeta === "function"
            ? getAdminProfileMeta(resolvedUsername, resolvedEmail)
            : null;
        const resolvedIsAdmin = typeof basePayload.isAdmin === "boolean"
            ? basePayload.isAdmin
            : !!derivedAdminMeta?.isAdmin;
        const resolvedRole = basePayload.role || (resolvedIsAdmin ? "admin" : "user");
        const resolvedAdminTitle = basePayload.adminTitle || (resolvedIsAdmin ? (derivedAdminMeta?.adminTitle || "Kurucu Admin") : "");
        const dailyStudyTime = Math.max(
            getFreshDailyStudySeconds(basePayload, safeSchedule),
            isCurrentUserTarget ? getCurrentDayWorkedSeconds() : getCurrentDayWorkedSecondsFromSchedule(safeSchedule)
        );
        const weeklyStudyTime = Math.max(
            parseInteger(basePayload.weeklyStudyTime, 0),
            parseInteger(basePayload.currentWeekSeconds, 0),
            typeof getCurrentWeekTotalsFromSchedule === "function"
                ? getCurrentWeekTotalsFromSchedule(safeSchedule).seconds
                : 0
        );
        const activeTimer = basePayload.activeTimer || (isCurrentUserTarget && timerState.session ? serializeTimerSession(timerState.session) : null);
        const currentSessionTime = Math.max(
            parseInteger(basePayload.currentSessionTime, 0),
            isCurrentUserTarget && isTimerVisibleForLeaderboard(timerState.session) ? getTimerElapsedSeconds(timerState.session) : 0
        );
        const legacyWorkingStartedAt = Math.max(
            parseInteger(basePayload.legacyWorkingStartedAt, 0),
            activeTimer
                ? Math.max(
                    parseInteger(activeTimer.startedAtMs, 0),
                    Date.now() - (Math.max(0, currentSessionTime) * 1000)
                )
                : 0
        );
        const totalWorkedSeconds = Math.max(
            parseInteger(basePayload.totalWorkedSeconds, 0),
            parseInteger(basePayload.totalStudyTime, 0),
            typeof calculateTotalWorkedSecondsFromSchedule === "function"
                ? calculateTotalWorkedSecondsFromSchedule(safeSchedule)
                : 0
        );
        const totalQuestionsAllTime = Math.max(
            parseInteger(basePayload.totalQuestionsAllTime, 0),
            questionCounters.dailyQuestions,
            questionCounters.weeklyQuestions,
            typeof calculateTotalQuestionsFromSchedule === "function"
                ? calculateTotalQuestionsFromSchedule(safeSchedule)
                : 0
        );
        const publicNotes = typeof getPublicUserNotes === "function"
            ? getPublicUserNotes(
                (isCurrentUserTarget && Array.isArray(userNotes) && userNotes.length ? userNotes : (basePayload.notes || []))
            )
            : [];
        const resolvedTitleInfo = buildResolvedTitleInfo({
            uid: String(basePayload.uid || (isCurrentUserTarget ? (currentUser?.uid || "") : "")),
            schedule: safeSchedule,
            activeTimer,
            selectedTitleId: resolvedSelectedTitleId,
            titleAwards: resolvedTitleAwards
        });

        return {
            uid: String(basePayload.uid || (isCurrentUserTarget ? (currentUser?.uid || "") : "")),
            username: resolvedUsername || "Kullanici",
            email: resolvedEmail,
            role: resolvedRole,
            isAdmin: resolvedIsAdmin,
            adminTitle: resolvedAdminTitle,
            about: String((isCurrentUserTarget ? (currentProfileAbout || "") : "") || basePayload.about || "").trim(),
            profileImage: (isCurrentUserTarget ? (currentProfileImage || "") : "") || basePayload.profileImage || "",
            accountCreatedAt: (isCurrentUserTarget ? (currentAccountCreatedAt || "") : "") || basePayload.accountCreatedAt || "",
            studyTrack: resolvedStudyTrack,
            selectedSubjects: resolvedSelectedSubjects,
            selectedTitleId: resolvedTitleInfo.selectedTitleId,
            titleAwards: resolvedTitleInfo.titleAwards,
            dailyStudyTime,
            dailyStudyDateKey: currentDayMeta.dateKey,
            weeklyStudyTime,
            currentWeekSeconds: weeklyStudyTime,
            currentSessionTime,
            legacyWorkingStartedAt,
            activeTimer,
            isWorking: !!basePayload.isWorking || isTimerVisibleForLeaderboard(activeTimer),
            totalWorkedSeconds,
            totalStudyTime: totalWorkedSeconds,
            daily: questionCounters.dailyQuestions,
            weekly: questionCounters.weeklyQuestions,
            total: totalQuestionsAllTime,
            dailyQuestions: questionCounters.dailyQuestions,
            weeklyQuestions: questionCounters.weeklyQuestions,
            dailyQuestionCount: questionCounters.dailyQuestions,
            weeklyQuestionCount: questionCounters.weeklyQuestions,
            totalQuestionsAllTime,
            lastTimerSyncAt: parseInteger(basePayload.lastTimerSyncAt, Date.now()),
            notes: publicNotes
        };
    }

    function syncPublicProfileSnapshot(basePayload = null) {
        if (!currentUser?.uid) return Promise.resolve();
        const userPayload = basePayload || (typeof buildUserPayload === "function" ? buildUserPayload() : {});
        const publicPayload = buildPublicProfilePayload(userPayload);
        return db.collection(PUBLIC_PROFILE_COLLECTION).doc(currentUser.uid).set(publicPayload, { merge: true });
    }

    function syncPublicProfileSnapshotSafely(basePayload = null) {
        return syncPublicProfileSnapshot(basePayload).catch(error => {
            console.error("Public profil anlik senkronu basarisiz:", error);
        });
    }

    function syncLeaderboardSnapshot(basePayload = null) {
        if (!currentUser?.uid) return Promise.resolve(basePayload || null);
        const userPayload = basePayload || (typeof buildUserPayload === "function" ? buildUserPayload() : {});
        const normalizedPayload = normalizeLiveLeaderboardDocData({
            ...userPayload,
            uid: currentUser.uid
        }, currentUser.uid);
        const docIndex = leaderboardRealtimeDocs.findIndex(item => item.id === currentUser.uid);
        if (docIndex >= 0) {
            leaderboardRealtimeDocs[docIndex] = { id: currentUser.uid, data: normalizedPayload };
        } else {
            leaderboardRealtimeDocs.push({ id: currentUser.uid, data: normalizedPayload });
        }
        return Promise.resolve(normalizedPayload);
    }

    function syncLeaderboardSnapshotSafely(basePayload = null) {
        return syncLeaderboardSnapshot(basePayload).catch(error => {
            console.error("Leaderboard anlik senkronu basarisiz:", error);
        });
    }

    function isPresenceOnlyTimerSyncReason(reason = "") {
        const normalizedReason = String(reason || "").trim().toLowerCase();
        return normalizedReason === "modal-show"
            || normalizedReason === "modal-hide"
            || normalizedReason === "visibility-hidden"
            || normalizedReason === "visibility-visible";
    }

    function buildRealtimeLeaderboardPresencePayload(basePayload = {}) {
        return buildLeaderboardDocumentPayload({
            ...(currentUserLiveDoc || {}),
            ...(basePayload || {}),
            uid: currentUser?.uid || basePayload?.uid || ""
        });
    }

    function syncRealtimeLeaderboardPresence(basePayload = {}) {
        if (!currentUser?.uid) return Promise.resolve(basePayload);
        const leaderboardPayload = buildRealtimeLeaderboardPresencePayload(basePayload);
        return syncLeaderboardSnapshot(leaderboardPayload).then(() => leaderboardPayload);
    }

    function syncPublicQuestionCountersNow() {
        if (!currentUser?.uid) return Promise.resolve();
        scheduleData = sanitizeScheduleData(scheduleData || {});
        refreshCurrentTotals();

        const dailyQuestions = getCurrentDayQuestionsFromSchedule(scheduleData);
        const weeklyQuestions = getCurrentWeekQuestionsFromSchedule(scheduleData);
        const resolvedUsername = String(
            currentUsername
            || currentUser?.displayName
            || currentUser?.email?.split("@")[0]
            || ""
        ).trim();

        const questionPatch = {
            uid: currentUser.uid,
            username: resolvedUsername || "Kullanici",
            daily: dailyQuestions,
            weekly: weeklyQuestions,
            leaderboardDailyQuestions: dailyQuestions,
            leaderboardWeeklyQuestions: weeklyQuestions,
            dailyQuestions,
            weeklyQuestions,
            dailyQuestionCount: dailyQuestions,
            weeklyQuestionCount: weeklyQuestions,
            totalQuestionsAllTime: totalQuestionsAllTime || 0,
            total: totalQuestionsAllTime || 0,
            lastTimerSyncAt: Date.now()
        };
        const userQuestionPatch = {
            ...(typeof buildUserPayload === "function" ? buildUserPayload() : {}),
            ...questionPatch,
            email: currentUser?.email || "",
            schedule: scheduleData,
            totalQuestionsAllTime: totalQuestionsAllTime || 0
        };
        questionPatch.selectedTitleId = userQuestionPatch.selectedTitleId || "";
        questionPatch.titleAwards = userQuestionPatch.titleAwards || {};
        const leaderboardPayload = buildLeaderboardDocumentPayload({
            ...userQuestionPatch,
            ...questionPatch
        });
        currentUserLiveDoc = {
            ...(currentUserLiveDoc || {}),
            ...userQuestionPatch
        };
        syncLeaderboardSnapshot({
            ...currentUserLiveDoc,
            ...leaderboardPayload
        }).catch(error => {
            console.error("Yerel lider tablo guncellemesi basarisiz:", error);
        });
        return Promise.resolve(questionPatch);
    }

    async function syncLeaderboardCollectionFromUsers() {
        const usersSnapshot = await db.collection("users").get();
        return { updatedCount: usersSnapshot.size || 0, skipped: true, reason: "users-only-leaderboard" };
    }

    async function maybeAutoSyncLeaderboardCollection(options = {}) {
        return { skipped: true, reason: "users-only-leaderboard" };
    }

    window.syncLeaderboardCollectionFromUsers = async function() {
        const result = { skipped: true, reason: "users-only-leaderboard" };
        safeShowAlert("Lider tablo artik dogrudan users koleksiyonundan besleniyor.", "success");
        return result;
    };

    function applyStudyDelta(deltaSeconds, date = new Date()) {
        if (!deltaSeconds) return;
        const { weekKey, dayIdx } = getCurrentDayMeta(date);
        const dayData = ensureWeekDay(weekKey, dayIdx);
        dayData.workedSeconds = Math.max(0, parseInteger(dayData.workedSeconds, 0) + deltaSeconds);
        scheduleData[weekKey][dayIdx] = ensureDayObject(dayData);
        refreshCurrentTotals();
    }

    function getCurrentDayWorkedSeconds(date = new Date()) {
        const { weekKey, dayIdx } = getCurrentDayMeta(date);
        const dayData = scheduleData?.[weekKey]?.[dayIdx];
        return dayData ? (ensureDayObject(dayData).workedSeconds || 0) : 0;
    }

    function mergeFreshDailySnapshotIntoLocalSchedule(userData = {}, referenceDate = new Date()) {
        const remoteSchedule = sanitizeScheduleData(userData?.schedule || {});
        const { weekKey, dayIdx, dateKey } = getCurrentDayMeta(referenceDate);
        const localDayData = ensureDayObject(scheduleData?.[weekKey]?.[dayIdx] || {});
        const remoteDayData = ensureDayObject(remoteSchedule?.[weekKey]?.[dayIdx] || {});
        const explicitDailySeconds = getFreshDailyStudySeconds(userData, remoteSchedule, referenceDate);
        const adminTimeAdjustment = normalizeAdminTimeAdjustment(userData?.adminTimeAdjustment);
        const shouldForceReplaceFromAdmin = !!adminTimeAdjustment
            && adminTimeAdjustment.dateKey === dateKey;

        if (shouldForceReplaceFromAdmin && adminTimeAdjustment.scope === "total") {
            scheduleData = sanitizeScheduleData(remoteSchedule);
            if (typeof refreshCurrentTotals === "function") {
                refreshCurrentTotals();
            }
            return true;
        }

        if (
            shouldForceReplaceFromAdmin
            && adminTimeAdjustment.scope === "week"
            && (!adminTimeAdjustment.weekKey || adminTimeAdjustment.weekKey === weekKey)
        ) {
            if (!scheduleData || typeof scheduleData !== "object") {
                scheduleData = {};
            }
            scheduleData = sanitizeScheduleData(scheduleData);
            scheduleData[weekKey] = sanitizeScheduleData(remoteSchedule)?.[weekKey] || {};
            if (typeof refreshCurrentTotals === "function") {
                refreshCurrentTotals();
            }
            return true;
        }

        const currentStoredSeconds = Math.max(
            parseInteger(localDayData.workedSeconds, 0),
            parseInteger(remoteDayData.workedSeconds, 0)
        );
        const nextWorkedSeconds = shouldForceReplaceFromAdmin
            ? Math.max(
                0,
                parseInteger(remoteDayData.workedSeconds, 0),
                explicitDailySeconds,
                adminTimeAdjustment.appliedDaySeconds,
                adminTimeAdjustment.targetSeconds
            )
            : Math.max(currentStoredSeconds, explicitDailySeconds);

        if (!shouldForceReplaceFromAdmin && nextWorkedSeconds <= currentStoredSeconds) {
            return false;
        }

        if (!scheduleData || typeof scheduleData !== "object") {
            scheduleData = sanitizeScheduleData(remoteSchedule);
        }
        if (!scheduleData[weekKey]) scheduleData[weekKey] = {};

        scheduleData[weekKey][dayIdx] = ensureDayObject({
            ...remoteDayData,
            ...localDayData,
            workedSeconds: nextWorkedSeconds
        });

        if (typeof refreshCurrentTotals === "function") {
            refreshCurrentTotals();
        }
        return true;
    }

    function buildRealtimeStudyPayload(options = {}) {
        scheduleData = sanitizeScheduleData(scheduleData || {});
        refreshCurrentTotals();

        const syncTimestamp = Date.now();
        const currentDayMeta = getCurrentDayMeta(new Date());
        const resolvedSelectedTitleId = getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {});
        const resolvedTitleAwards = getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {});
        const currentDayWorkedSeconds = getCurrentDayWorkedSeconds();
        const activeSession = options.activeSession === undefined ? timerState.session : options.activeSession;
        const activeTimerRecord = activeSession ? serializeTimerSession(activeSession) : null;
        const sessionPendingSeconds = activeSession && activeSession.isRunning
            ? getPendingTimerDelta(activeSession)
            : 0;
        const resolvedCurrentSessionTime = options.currentSessionTime === undefined
            ? sessionPendingSeconds
            : Math.max(0, Math.min(parseInteger(options.currentSessionTime, sessionPendingSeconds), sessionPendingSeconds));
        const resolvedName = String(
            currentUsername
            || currentUser?.displayName
            || currentUser?.email?.split("@")[0]
            || currentUserLiveDoc?.username
            || currentUserLiveDoc?.name
            || ""
        ).trim() || "Kullanici";
        const legacyWorkingStartedAt = activeSession && activeSession.isRunning
            ? Math.max(
                parseInteger(activeSession.startedAtMs, 0),
                syncTimestamp - (Math.max(0, getTimerElapsedSeconds(activeSession)) * 1000)
            )
            : 0;
        const questionCounters = buildQuestionCounterPayload(scheduleData);
        const resolvedTitleInfo = buildResolvedTitleInfo({
            uid: currentUser?.uid || "",
            schedule: scheduleData,
            activeTimer: activeTimerRecord,
            selectedTitleId: resolvedSelectedTitleId,
            titleAwards: resolvedTitleAwards
        });
        const currentWeekWorkedSeconds = typeof getCurrentWeekTotalsFromSchedule === "function"
            ? getCurrentWeekTotalsFromSchedule(scheduleData || {}).seconds
            : (totalWorkedSecondsAllTime || 0);

        return {
            schedule: scheduleData,
            name: resolvedName,
            totalWorkedSeconds: totalWorkedSecondsAllTime || 0,
            totalStudyTime: totalWorkedSecondsAllTime || 0,
            totalTime: Math.max(0, parseInteger(totalWorkedSecondsAllTime, 0)) * 1000,
            totalQuestionsAllTime: totalQuestionsAllTime || 0,
            ...questionCounters,
            selectedTitleId: resolvedTitleInfo.selectedTitleId,
            titleAwards: resolvedTitleInfo.titleAwards,
            dailyStudyTime: currentDayWorkedSeconds,
            dailyStudyDateKey: currentDayMeta.dateKey,
            weeklyStudyTime: currentWeekWorkedSeconds,
            currentWeekSeconds: currentWeekWorkedSeconds,
            currentSessionTime: resolvedCurrentSessionTime,
            legacyWorkingStartedAt,
            activeTimer: activeTimerRecord,
            isWorking: isTimerVisibleForLeaderboard(activeTimerRecord),
            isRunning: !!activeSession?.isRunning,
            lastSyncTime: syncTimestamp,
            lastTimerSyncAt: syncTimestamp,
            emailVerified: !!currentUser?.emailVerified
        };
    }

    function hasAnyScheduleEntries(schedule = {}) {
        return Object.values(schedule || {}).some(week => week && Object.keys(week).length > 0);
    }

    function buildOptimisticCurrentUserData(baseData = {}, activeSessionOverride) {
        const normalizedLocalSchedule = sanitizeScheduleData(scheduleData || {});
        const normalizedBaseSchedule = sanitizeScheduleData(baseData.schedule || {});
        const resolvedSchedule = hasAnyScheduleEntries(normalizedLocalSchedule) ? normalizedLocalSchedule : normalizedBaseSchedule;
        const questionCounters = buildQuestionCounterPayload(resolvedSchedule);
        const resolvedSelectedTitleId = getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {}, baseData);
        const resolvedTitleAwards = getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {}, baseData);
        const resolvedSelectedSubjects = typeof normalizeSelectedSubjects === "function"
            ? normalizeSelectedSubjects(
                studyTrack || baseData.studyTrack || "",
                (selectedSubjects && selectedSubjects.length) ? selectedSubjects : (baseData.selectedSubjects || [])
            )
            : ((selectedSubjects && selectedSubjects.length) ? selectedSubjects : (baseData.selectedSubjects || []));
        const resolvedTotalWorkedSeconds = Math.max(
            totalWorkedSecondsAllTime || 0,
            parseInteger(baseData.totalWorkedSeconds, 0),
            parseInteger(baseData.totalStudyTime, 0),
            typeof calculateTotalWorkedSecondsFromSchedule === "function"
                ? calculateTotalWorkedSecondsFromSchedule(resolvedSchedule)
                : 0
        );
        const resolvedTotalQuestions = Math.max(
            totalQuestionsAllTime || 0,
            parseInteger(baseData.totalQuestionsAllTime, 0),
            typeof calculateTotalQuestionsFromSchedule === "function"
                ? calculateTotalQuestionsFromSchedule(resolvedSchedule)
                : 0
        );
        const resolvedActiveTimer = activeSessionOverride === undefined ? (timerState.session ? serializeTimerSession(timerState.session) : null) : activeSessionOverride;
        const resolvedTitleInfo = buildResolvedTitleInfo({
            uid: currentUser?.uid || baseData.uid || "",
            schedule: resolvedSchedule,
            activeTimer: resolvedActiveTimer,
            selectedTitleId: resolvedSelectedTitleId,
            titleAwards: resolvedTitleAwards
        });

        return {
            ...baseData,
            username: currentUsername || baseData.username || "Kullanıcı",
            name: currentUsername || baseData.name || baseData.username || "Kullanici",
            email: currentUser?.email || baseData.email || "",
            isAdmin: typeof isCurrentAdmin === "function" ? isCurrentAdmin() : !!baseData.isAdmin,
            about: currentProfileAbout || baseData.about || "",
            profileImage: currentProfileImage || baseData.profileImage || "",
            accountCreatedAt: currentAccountCreatedAt || baseData.accountCreatedAt || "",
            studyTrack: studyTrack || baseData.studyTrack || "",
            selectedSubjects: resolvedSelectedSubjects,
            selectedTitleId: resolvedTitleInfo.selectedTitleId,
            titleAwards: resolvedTitleInfo.titleAwards,
            schedule: resolvedSchedule,
            totalWorkedSeconds: resolvedTotalWorkedSeconds,
            totalStudyTime: resolvedTotalWorkedSeconds,
            totalTime: resolvedTotalWorkedSeconds * 1000,
            totalQuestionsAllTime: resolvedTotalQuestions,
            ...questionCounters,
            activeTimer: resolvedActiveTimer,
            isWorking: isTimerRecordRunning(activeSessionOverride === undefined ? timerState.session : activeSessionOverride),
            isRunning: isTimerRecordRunning(activeSessionOverride === undefined ? timerState.session : activeSessionOverride),
            lastSyncTime: Date.now(),
            currentSessionTime: Math.max(0, getPendingTimerDelta(activeSessionOverride === undefined ? timerState.session : activeSessionOverride)),
            notes: typeof normalizeUserNotes === "function"
                ? normalizeUserNotes((userNotes && userNotes.length) ? userNotes : (baseData.notes || []))
                : ((userNotes && userNotes.length) ? userNotes : (baseData.notes || []))
        };
    }

    function hasLocalLeaderboardActivity() {
        const safeSchedule = sanitizeScheduleData(scheduleData || {});
        const totalLocalSeconds = typeof calculateTotalWorkedSecondsFromSchedule === "function"
            ? calculateTotalWorkedSecondsFromSchedule(safeSchedule)
            : parseInteger(totalWorkedSecondsAllTime, 0);
        const totalLocalQuestions = typeof calculateTotalQuestionsFromSchedule === "function"
            ? calculateTotalQuestionsFromSchedule(safeSchedule)
            : parseInteger(totalQuestionsAllTime, 0);

        return totalLocalSeconds > 0
            || totalLocalQuestions > 0
            || !!timerState.session?.isRunning;
    }

    function buildLocalLeaderboardPreviewDoc(activeSessionOverride) {
        const docId = currentUser?.uid || LOCAL_LEADERBOARD_PREVIEW_ID;
        const baseDoc = currentUser?.uid
            ? (leaderboardRealtimeDocs.find(item => item.id === currentUser.uid)?.data || currentUserLiveDoc || {})
            : (currentUserLiveDoc || {});
        const data = buildOptimisticCurrentUserData(baseDoc, activeSessionOverride);

        return {
            id: docId,
            data: {
                ...data,
                username: currentUsername || data.username || "Sen",
                isLocalPreview: !currentUser
            }
        };
    }

    function getLeaderboardSourceDocs(activeSessionOverride) {
        const docs = leaderboardRealtimeDocs.map(item => ({ id: item.id, data: item.data || {} }));
        if (!hasLocalLeaderboardActivity()) return docs;

        const localDoc = buildLocalLeaderboardPreviewDoc(activeSessionOverride);
        const docIndex = docs.findIndex(item => item.id === localDoc.id);
        if (docIndex >= 0) {
            docs[docIndex] = localDoc;
        } else {
            docs.push(localDoc);
        }

        return docs;
    }

    function refreshLeaderboardOptimistically(activeSessionOverride) {
        if (currentUser?.uid) {
            const docIndex = leaderboardRealtimeDocs.findIndex(item => item.id === currentUser.uid);
            const baseData = docIndex >= 0 ? (leaderboardRealtimeDocs[docIndex]?.data || {}) : (currentUserLiveDoc || {});
            const docData = buildOptimisticCurrentUserData(baseData, activeSessionOverride);

            if (docIndex >= 0) {
                leaderboardRealtimeDocs[docIndex] = { id: currentUser.uid, data: docData };
            } else {
                leaderboardRealtimeDocs.push({ id: currentUser.uid, data: docData });
            }
        }

        if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
            renderLiveLeaderboardFromDocs();
        }
    }

    async function syncRealtimeTimer(reason = "manual", options = {}) {
        if (timerState.session) {
            const delta = applyPendingTimerDelta(timerState.session);
            if (delta > 0) {
                timerState.session.lastPersistedElapsedSeconds = getTimerElapsedSeconds(timerState.session);
            }
        }

        const activeSession = options.clearActive ? null : (options.activeSession === undefined ? timerState.session : options.activeSession);
        persistTimerSessionLocally(activeSession);
        updateLocalActiveTimerSnapshot(activeSession);

        if (options.userTriggeredWrite && currentUser && ensureManualWriteAllowed(`timer:${reason}`)) {
            try {
                await queueCurrentUserWrite(`timer:${reason}`, async () => {
                    const payload = buildRealtimeStudyPayload({
                        activeSession,
                        currentSessionTime: options.currentSessionTime
                    });
                    await db.collection("users").doc(currentUser.uid).set(payload, { merge: true });
                });
            } catch (error) {
                console.error("Gercek zamanli sure senkronu basarisiz:", error);
            }
        }

        if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
            renderLiveLeaderboardFromDocs();
        }

        renderSchedule();
    }

    function updateLiveStudyPreview() {
        const unsavedDelta = timerState.session?.isRunning ? getPendingTimerDelta(timerState.session) : 0;
        const currentDayWorked = getCurrentDayWorkedSeconds() + unsavedDelta;
        const currentWeekTotals = typeof getCurrentWeekTotalsFromSchedule === "function"
            ? getCurrentWeekTotalsFromSchedule(scheduleData || {}).seconds + unsavedDelta
            : totalWorkedSecondsAllTime + unsavedDelta;

        const todayNode = document.getElementById("today-worked-time");
        const weekNode = document.getElementById("all-time-score");
        const profileNode = document.getElementById("profile-total-work");

        if (todayNode) {
            todayNode.textContent = `Gunluk Sure: ${typeof formatSeconds === "function" ? formatSeconds(currentDayWorked) : currentDayWorked}`;
        }

        if (weekNode) {
            weekNode.textContent = `Haftalik Sure: ${typeof formatSeconds === "function" ? formatSeconds(currentWeekTotals) : currentWeekTotals}`;
        }

        if (profileNode && document.getElementById("profile-modal")?.style.display === "flex" && currentProfileModalEditable) {
            profileNode.textContent = typeof formatSeconds === "function" ? formatSeconds((totalWorkedSecondsAllTime || 0) + unsavedDelta) : String((totalWorkedSecondsAllTime || 0) + unsavedDelta);
        }

        const todayCell = document.querySelector(".day-cell.active-today .day-score-display");
        if (todayCell) {
            todayCell.textContent = `${typeof formatSeconds === "function" ? formatSeconds(currentDayWorked) : currentDayWorked}`;
        }

        updateTimerSessionPill();
        refreshLeaderboardOptimistically();
    }

    function getTodayQuestionState() {
        const today = new Date();
        const todayDayIdx = (today.getDay() + 6) % 7;
        const todayWeekStart = new Date(today);
        todayWeekStart.setHours(0, 0, 0, 0);
        todayWeekStart.setDate(todayWeekStart.getDate() - todayDayIdx);

        const todayWeekKey = typeof getWeekKey === "function" ? getWeekKey(todayWeekStart) : "";
        const todayDay = ensureDayObject(scheduleData?.[todayWeekKey]?.[todayDayIdx] || {});

        return { todayWeekKey, todayDayIdx, todayDay };
    }

    function refreshQuestionSummaryCounters() {
        scheduleData = sanitizeScheduleData(scheduleData || {});

        const todayNode = document.getElementById("today-question-count");
        const weekNode = document.getElementById("week-question-count");
        const { todayDay } = getTodayQuestionState();

        if (todayNode) {
            todayNode.textContent = `Gunluk Soru: ${parseInteger(todayDay?.questions, 0)}`;
        }

        if (weekNode) {
            const currentWeekKey = typeof getWeekKey === "function" ? getWeekKey(currentWeekStart) : "";
            const currentWeek = scheduleData?.[currentWeekKey] || {};
            let totalWeeklyQuestions = 0;

            for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
                totalWeeklyQuestions += parseInteger(currentWeek?.[dayIdx]?.questions, 0);
            }

            weekNode.textContent = `Haftalik Soru: ${totalWeeklyQuestions}`;
        }
    }

    function syncQuestionCountersAfterInput(dayIdx, questionsValue) {
        const normalizedValue = parseInteger(questionsValue, 0);
        const today = new Date();
        const todayDayIdx = (today.getDay() + 6) % 7;
        const displayedWeekKey = typeof getWeekKey === "function" ? getWeekKey(currentWeekStart) : "";
        const todayWeekStart = new Date(today);
        todayWeekStart.setHours(0, 0, 0, 0);
        todayWeekStart.setDate(todayWeekStart.getDate() - todayDayIdx);
        const todayWeekKey = typeof getWeekKey === "function" ? getWeekKey(todayWeekStart) : "";

        if (displayedWeekKey === todayWeekKey && dayIdx === todayDayIdx) {
            const todayNode = document.getElementById("today-question-count");
            if (todayNode) {
                todayNode.textContent = `Gunluk Soru: ${normalizedValue}`;
            }
        }

        refreshQuestionSummaryCounters();
    }

    async function startOrResumeRealtimeTimer() {
        if (guardVerifiedAccess()) return;

        const mode = timerState.mode;
        let session = timerState.session;

        if (!session || session.mode !== mode) {
            session = createEmptyTimerSession(mode);
        }

        if (mode === "pomodoro") {
            const totalSeconds = getPomodoroInputSeconds();
            if (totalSeconds <= 0) {
                safeShowAlert("Pomodoro suresi 0 olamaz.");
                return;
            }
            if (!session.baseElapsedSeconds && !session.lastPersistedElapsedSeconds) {
                session.targetDurationSeconds = totalSeconds;
            } else {
                session.targetDurationSeconds = Math.max(totalSeconds, session.baseElapsedSeconds || totalSeconds);
            }
        } else {
            session.targetDurationSeconds = 0;
        }

        session.mode = mode;
        session.isRunning = true;
        session.startedAtMs = Date.now();

        timerState.session = session;
        timerDrafts[mode] = { ...session };
        isRunning = true;
        persistTimerSessionLocally(session);

        startTimerLoops();
        renderTimerUi();
        refreshLeaderboardOptimistically();
        await syncRealtimeTimer("start", {
            activeSession: session,
            currentSessionTime: getTimerDisplaySeconds(session),
            userTriggeredWrite: true,
            authorized: true
        });
    }

    async function pauseRealtimeTimer() {
        if (!timerState.session) return;

        const session = timerState.session;
        const elapsed = getTimerElapsedSeconds(session);
        session.baseElapsedSeconds = elapsed;
        session.lastPersistedElapsedSeconds = elapsed;
        session.isRunning = false;
        session.startedAtMs = 0;
        timerState.session = session;
        timerDrafts[session.mode] = { ...session };
        isRunning = false;
        stopTimerLoops();
        await syncRealtimeTimer("pause", {
            activeSession: null,
            currentSessionTime: 0,
            clearActive: true,
            commitElapsed: true,
            userTriggeredWrite: true,
            authorized: true
        });
        refreshLeaderboardOptimistically(null);
        renderTimerUi();
    }

    async function completePomodoroSession() {
        if (!timerState.session) return;

        const session = timerState.session;
        session.baseElapsedSeconds = Math.max(parseInteger(session.targetDurationSeconds, 0), getTimerElapsedSeconds(session));
        session.isRunning = false;
        session.startedAtMs = 0;
        stopTimerLoops();
        isRunning = false;

        await syncRealtimeTimer("complete", {
            activeSession: null,
            currentSessionTime: 0,
            clearActive: true
        });

        timerState.session = createEmptyTimerSession("pomodoro");
        timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
        timerDrafts.pomodoro = { ...timerState.session };
        persistTimerSessionLocally(null);
        releaseTimerOwnership();
        refreshLeaderboardOptimistically(null);
        renderTimerUi();
        safeShowAlert("Pomodoro oturumu tamamlandı. Süre otomatik kaydedildi.", "success");
    }

    async function resetRealtimeTimer(resetInputs = true, silent = false) {
        if (timerState.session) {
            const delta = applyPendingTimerDelta(timerState.session);
            if (delta > 0) {
                timerState.session.lastPersistedElapsedSeconds = getTimerElapsedSeconds(timerState.session);
            }
        }

        stopTimerLoops();
        isRunning = false;
        timerState.session = null;
        persistTimerSessionLocally(null);
        releaseTimerOwnership();

        if (resetInputs && timerState.mode === "pomodoro") {
            const hours = document.getElementById("study-hours");
            const minutes = document.getElementById("study-minutes");
            const seconds = document.getElementById("study-seconds");
            if (hours) hours.value = 0;
            if (minutes) minutes.value = 0;
            if (seconds) seconds.value = 0;
        }

        await syncRealtimeTimer("reset", {
            activeSession: null,
            currentSessionTime: 0,
            clearActive: true
        });

        timerState.session = createEmptyTimerSession(timerState.mode);
        if (timerState.mode === "pomodoro") {
            timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
        }
        timerDrafts[timerState.mode] = { ...timerState.session };

        refreshLeaderboardOptimistically(null);
        renderTimerUi();
        if (!silent) {
            safeShowAlert("Zamanlayıcı sıfırlandı.");
        }
    }

    function restoreTimerFromPersistence(userData = {}) {
        const adminTimerReset = normalizeAdminTimerReset(userData.adminTimerReset);
        if (adminTimerReset) {
            writeHandledAdminTimerResetSignature(adminTimerReset);
        }
        stopTimerLoops();
        releaseTimerOwnership();
        isRunning = false;
        const storedSession = readStoredTimerSession();
        const storedSessionMatchesUser = !!storedSession
            && (!storedSession.uid || !currentUser?.uid || storedSession.uid === currentUser.uid);
        const remoteSession = userData?.activeTimer && isTimerRecordRunning(userData.activeTimer)
            ? userData.activeTimer
            : null;
        const seedSession = storedSessionMatchesUser ? storedSession : (remoteSession || null);

        if (seedSession?.mode) {
            timerState.mode = seedSession.mode === "stopwatch" ? "stopwatch" : "pomodoro";
            try {
                localStorage.setItem(TIMER_MODE_KEY, timerState.mode);
            } catch (error) {
                console.error("Timer modu kaydedilemedi:", error);
            }
        }

        if (seedSession) {
            const seedSessionRunning = isTimerRecordRunning(seedSession);
            const frozenElapsedSeconds = getTimerElapsedSeconds(seedSession);
            timerState.session = {
                mode: seedSession.mode === "stopwatch" ? "stopwatch" : "pomodoro",
                isRunning: seedSessionRunning,
                baseElapsedSeconds: seedSessionRunning
                    ? Math.max(0, parseInteger(seedSession.baseElapsedSeconds, 0))
                    : frozenElapsedSeconds,
                lastPersistedElapsedSeconds: Math.max(0, parseInteger(seedSession.lastPersistedElapsedSeconds, 0)),
                targetDurationSeconds: Math.max(0, parseInteger(seedSession.targetDurationSeconds, 0)),
                startedAtMs: seedSessionRunning ? Math.max(0, parseInteger(seedSession.startedAtMs, Date.now())) : 0,
                updatedAtMs: Math.max(0, parseInteger(seedSession.updatedAtMs, Date.now())),
                lastSeenAtMs: getTimerLastSeenAt(seedSession),
                modalOpen: seedSessionRunning ? !!seedSession.modalOpen : false,
                ownerId: String(seedSession.ownerId || timerInstanceId)
            };
        } else {
            timerState.session = createEmptyTimerSession(timerState.mode);
            if (timerState.mode === "pomodoro") {
                timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
            }
        }

        timerDrafts[timerState.mode] = { ...timerState.session };
        if (timerState.session?.isRunning) {
            isRunning = true;
            startTimerLoops();
        }
        renderTimerUi();
    }

    function applyAdminTimerResetFromUserData(userData = {}, options = {}) {
        const adminTimerReset = normalizeAdminTimerReset(userData.adminTimerReset);
        if (!shouldHonorAdminTimerReset(adminTimerReset)) return false;

        const handledSignature = readHandledAdminTimerResetSignature();
        const currentSignature = getAdminTimerResetSignature(adminTimerReset);
        const liveSessionNeedsClear = shouldForceClearTimerFromAdminReset(adminTimerReset, timerState.session);
        const storedSessionNeedsClear = shouldForceClearTimerFromAdminReset(adminTimerReset, readStoredTimerSession());
        const shouldRefreshFromSnapshot = shouldApplyAdminResetSnapshot(adminTimerReset, userData);
        const shouldApply = liveSessionNeedsClear
            || storedSessionNeedsClear
            || (handledSignature !== currentSignature && shouldRefreshFromSnapshot);

        if (!shouldApply) {
            if (handledSignature !== currentSignature && !liveSessionNeedsClear && !storedSessionNeedsClear) {
                writeHandledAdminTimerResetSignature(adminTimerReset);
            }
            return false;
        }

        writeHandledAdminTimerResetSignature(adminTimerReset);
        stopTimerLoops();
        isRunning = false;
        persistTimerSessionLocally(null);
        releaseTimerOwnership();

        scheduleData = sanitizeScheduleData(userData.schedule || {});
        totalWorkedSecondsAllTime = Math.max(
            parseInteger(userData.totalWorkedSeconds, 0),
            parseInteger(userData.totalStudyTime, 0),
            typeof calculateTotalWorkedSecondsFromSchedule === "function"
                ? calculateTotalWorkedSecondsFromSchedule(scheduleData)
                : 0
        );
        totalQuestionsAllTime = Math.max(
            parseInteger(userData.totalQuestionsAllTime, 0),
            typeof calculateTotalQuestionsFromSchedule === "function"
                ? calculateTotalQuestionsFromSchedule(scheduleData)
                : 0
        );

        timerState.session = createEmptyTimerSession(timerState.mode);
        if (timerState.mode === "pomodoro") {
            timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
        }
        timerDrafts[timerState.mode] = { ...timerState.session };

        renderTimerUi();
        if (typeof renderSchedule === "function") {
            renderSchedule();
        }
        updateLiveStudyPreview();
        refreshLeaderboardOptimistically(null);

        if (!options.silent) {
            safeShowAlert("Admin bugunku calisma suresini sifirladi.", "success");
        }

        return true;
    }

    function getLiveLeaderboardSeconds(userData) {
        const currentDate = new Date();
        const normalizedUserData = getDailySnapshotResetState(userData || {}, currentDate).normalizedData;
        const { weekKey, dayIdx } = getCurrentDayMeta(currentDate);
        let totalSeconds = 0;
        let dayStartMs = 0;
        const now = Date.now();
        const liveSessionSnapshot = getLeaderboardLiveSessionSnapshot(normalizedUserData, now);
        const hasVisibleActiveTimer = isTimerVisibleForLeaderboard(normalizedUserData?.activeTimer, now);
        const explicitDailySeconds = getFreshDailyStudySeconds(normalizedUserData, normalizedUserData?.schedule || {}, currentDate);
        const explicitWeeklySeconds = Math.max(
            parseInteger(normalizedUserData?.weeklyStudyTime, 0),
            parseInteger(normalizedUserData?.currentWeekSeconds, 0)
        );
        if (currentLeaderboardTab === "daily") {
            const dayStart = new Date(currentDate);
            dayStart.setHours(0, 0, 0, 0);
            dayStartMs = dayStart.getTime();
            totalSeconds = clampWorkedSecondsForDisplay(normalizedUserData?.schedule?.[weekKey]?.[dayIdx]?.workedSeconds, dayStart, now);
            totalSeconds = Math.max(totalSeconds, explicitDailySeconds);
        } else {
            totalSeconds = typeof getCurrentWeekTotalsFromSchedule === "function"
                ? getCurrentWeekTotalsFromSchedule(normalizedUserData?.schedule || {}).seconds
                : getRollingSevenDayTotalsFromSchedule(normalizedUserData?.schedule || {}, currentDate).seconds;
            totalSeconds = Math.max(totalSeconds, explicitWeeklySeconds);
        }

        const activeTimer = normalizedUserData?.activeTimer;
        if (hasVisibleActiveTimer) {
            const pendingInterval = getPendingTimerInterval(activeTimer, now);

            if (currentLeaderboardTab === "daily") {
                totalSeconds += getWindowOverlapSeconds(pendingInterval, dayStartMs, dayStartMs + 86400000);
            } else {
                const weekStart = new Date(currentDate);
                weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
                weekStart.setHours(0, 0, 0, 0);
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekEnd.getDate() + 7);
                totalSeconds += getWindowOverlapSeconds(pendingInterval, weekStart.getTime(), Math.min(now, weekEnd.getTime()));
            }
        }

        if (!hasVisibleActiveTimer && liveSessionSnapshot.seconds > 0) {
            if (currentLeaderboardTab === "daily") {
                totalSeconds = Math.max(
                    totalSeconds,
                    liveSessionSnapshot.seconds,
                    explicitDailySeconds + liveSessionSnapshot.seconds
                );
            } else {
                totalSeconds = Math.max(
                    totalSeconds,
                    liveSessionSnapshot.seconds,
                    explicitWeeklySeconds + liveSessionSnapshot.seconds
                );
            }
        }

        if (currentLeaderboardTab === "daily" && dayStartMs > 0) {
            const maxTodaySeconds = Math.max(0, Math.floor((now - dayStartMs) / 1000));
            totalSeconds = Math.min(totalSeconds, maxTodaySeconds);
        }

        return totalSeconds;
    }

    function getLeaderboardSessionLastSyncAt(userData = {}) {
        return Math.max(
            parseInteger(userData?.lastSyncTime, 0),
            parseInteger(userData?.lastTimerSyncAt, 0),
            parseInteger(userData?.updatedAtMs, 0),
            parseInteger(userData?.activeTimer?.lastSeenAtMs, 0),
            parseInteger(userData?.activeTimer?.updatedAtMs, 0),
            parseInteger(userData?.activeTimer?.startedAtMs, 0)
        );
    }

    function getLeaderboardLiveSessionSnapshot(userData = {}, now = Date.now()) {
        const activeTimer = userData?.activeTimer || null;
        const currentSessionTime = Math.max(0, parseInteger(userData?.currentSessionTime, 0));
        const legacyWorkingStartedAt = Math.max(0, parseInteger(userData?.legacyWorkingStartedAt, 0));
        const lastSyncAt = getLeaderboardSessionLastSyncAt(userData);
        const isRunning = !!userData?.isRunning || !!userData?.isWorking;
        const activeTimerVisible = isTimerVisibleForLeaderboard(activeTimer, now);

        if (activeTimerVisible) {
            return {
                seconds: Math.max(currentSessionTime, getTimerElapsedSeconds(activeTimer, now)),
                isLive: true,
                lastSyncAt
            };
        }

        if (currentSessionTime <= 0) {
            const legacyIsFresh = legacyWorkingStartedAt > 0 && (now - legacyWorkingStartedAt) < TIMER_AUTO_STOP_MS;
            if (legacyIsFresh && !!userData?.isWorking) {
                return {
                    seconds: Math.max(0, Math.floor((now - legacyWorkingStartedAt) / 1000)),
                    isLive: true,
                    lastSyncAt: Math.max(lastSyncAt, legacyWorkingStartedAt)
                };
            }
            return {
                seconds: 0,
                isLive: false,
                lastSyncAt: Math.max(lastSyncAt, legacyWorkingStartedAt)
            };
        }

        if (lastSyncAt <= 0) {
            return {
                seconds: currentSessionTime,
                isLive: isRunning,
                lastSyncAt
            };
        }

        const secondsSinceLastSync = Math.max(0, Math.floor((now - lastSyncAt) / 1000));
        const isFresh = (now - lastSyncAt) < REMOTE_TIMER_STALE_MS;
        const fallbackSeconds = isRunning
            ? Math.max(currentSessionTime, secondsSinceLastSync)
            : currentSessionTime;

        return {
            seconds: isFresh ? fallbackSeconds : currentSessionTime,
            isLive: isFresh && (isRunning || currentSessionTime > 0),
            lastSyncAt
        };
    }

    function getLeaderboardQuestionBreakdown(userData, referenceDate = new Date()) {
        const safeSchedule = sanitizeScheduleData(userData?.schedule || {});
        const dailyQuestions = Math.max(
            getCurrentDayQuestionsFromSchedule(safeSchedule, referenceDate),
            getExplicitQuestionCounterValue(userData || {}, ["leaderboardDailyQuestions", "dailyQuestionCount", "dailyQuestions", "daily"])
        );
        const weeklyQuestions = Math.max(
            getCurrentWeekQuestionsFromSchedule(safeSchedule, referenceDate),
            getExplicitQuestionCounterValue(userData || {}, ["leaderboardWeeklyQuestions", "weeklyQuestionCount", "weeklyQuestions", "weekly"])
        );

        return {
            dailyQuestions,
            weeklyQuestions,
            activeQuestions: currentLeaderboardTab === "daily" ? dailyQuestions : weeklyQuestions
        };
    }

    function getLiveLeaderboardQuestions(userData) {
        return getLeaderboardQuestionBreakdown(userData).activeQuestions;
    }

    function extractTrailingNumber(value) {
        const matches = String(value || "").match(/(\d+)/g);
        if (!matches || !matches.length) return 0;
        return parseInteger(matches[matches.length - 1], 0);
    }

    function getDisplayedQuestionCounts() {
        const todayNode = document.getElementById("today-question-count");
        const weekNode = document.getElementById("week-question-count");

        return {
            dailyQuestions: extractTrailingNumber(todayNode?.textContent || todayNode?.innerText || ""),
            weeklyQuestions: extractTrailingNumber(weekNode?.textContent || weekNode?.innerText || "")
        };
    }

    function buildForcedLocalLeaderboardEntry() {
        const baseData = currentUserLiveDoc && typeof currentUserLiveDoc === "object"
            ? currentUserLiveDoc
            : {};
        const data = buildOptimisticCurrentUserData(baseData);
        const seconds = getLiveLeaderboardSeconds(data);
        const liveSessionSnapshot = getLeaderboardLiveSessionSnapshot(data);
        const questionBreakdown = getLeaderboardQuestionBreakdown(data);
        const displayedQuestionCounts = getDisplayedQuestionCounts();
        const dailyQuestions = Math.max(questionBreakdown.dailyQuestions, displayedQuestionCounts.dailyQuestions);
        const weeklyQuestions = Math.max(questionBreakdown.weeklyQuestions, displayedQuestionCounts.weeklyQuestions);
        const questions = currentLeaderboardTab === "daily" ? dailyQuestions : weeklyQuestions;
        const currentWeekSeconds = typeof getCurrentWeekTotalsFromSchedule === "function"
            ? getCurrentWeekTotalsFromSchedule(data.schedule || {}).seconds
            : seconds;
        const isWorking = currentLeaderboardTab === "daily" && liveSessionSnapshot.isLive;
        const hasVisibleStats = seconds > 0 || isWorking;
        const titleInfo = buildResolvedTitleInfo({
            uid: currentUser?.uid || LOCAL_LEADERBOARD_PREVIEW_ID,
            schedule: sanitizeScheduleData(data.schedule || {}),
            activeTimer: data.activeTimer || (timerState.session ? serializeTimerSession(timerState.session) : null),
            selectedTitleId: getStoredSelectedTitleId(data, currentUserLiveDoc || {}, currentProfileModalData || {}),
            titleAwards: getStoredTitleAwards(data, currentUserLiveDoc || {}, currentProfileModalData || {})
        });

        if (!hasVisibleStats) return null;

        return {
            uid: currentUser?.uid || LOCAL_LEADERBOARD_PREVIEW_ID,
            username: currentUsername || data.username || "Sen",
            email: currentUser?.email || data.email || "",
            isAdmin: typeof isCurrentAdmin === "function" ? isCurrentAdmin() : !!data.isAdmin,
            about: currentProfileAbout || data.about || "",
            profileImage: currentProfileImage || data.profileImage || "",
            accountCreatedAt: currentAccountCreatedAt || data.accountCreatedAt || "",
            studyTrack: studyTrack || data.studyTrack || "",
            selectedSubjects: typeof normalizeSelectedSubjects === "function"
                ? normalizeSelectedSubjects(studyTrack || data.studyTrack || "", selectedSubjects && selectedSubjects.length ? selectedSubjects : (data.selectedSubjects || []))
                : (selectedSubjects && selectedSubjects.length ? selectedSubjects : (data.selectedSubjects || [])),
            selectedTitleId: titleInfo.selectedTitleId,
            titleAwards: titleInfo.titleAwards,
            currentWeekSeconds,
            schedule: sanitizeScheduleData(data.schedule || {}),
            activeTimer: data.activeTimer || (timerState.session ? serializeTimerSession(timerState.session) : null),
            titleInfo,
            competitionScore: seconds,
            seconds,
            questions,
            dailyQuestions,
            weeklyQuestions,
            totalWorkedSeconds: Math.max(
                parseInteger(data.totalWorkedSeconds, 0),
                parseInteger(data.totalStudyTime, 0),
                typeof calculateTotalWorkedSecondsFromSchedule === "function"
                    ? calculateTotalWorkedSecondsFromSchedule(data.schedule || {})
                    : 0
            ),
            currentPeriodQuestions: questions,
            totalQuestionsAllTime: Math.max(
                parseInteger(data.totalQuestionsAllTime, 0),
                dailyQuestions,
                weeklyQuestions,
                typeof calculateTotalQuestionsFromSchedule === "function"
                    ? calculateTotalQuestionsFromSchedule(data.schedule || {})
                    : 0
            ),
            isWorking,
            isLocalPreview: !currentUser,
            notes: typeof getPublicUserNotes === "function" ? getPublicUserNotes(data.notes || []) : []
        };
    }

    function getLeaderboardTitlePriority(user = {}) {
        const titleLevels = ensureRollingTwoDayTitleConfig();
        const titlePriorityMap = new Map(titleLevels.map((level, index) => [level.id, index + 1]));
        const currentTitleId = String(
            user?.titleInfo?.currentTitle?.id
            || user?.selectedTitleId
            || ""
        ).trim();
        const basePriority = titlePriorityMap.get(currentTitleId) || 0;
        return user?.isAdmin ? Math.max(basePriority, titleLevels.length + 1) : basePriority;
    }

    function compareLeaderboardEntries(left = {}, right = {}) {
        const secondsDiff = parseInteger(right.seconds, 0) - parseInteger(left.seconds, 0);
        if (secondsDiff !== 0) return secondsDiff;

        const titleDiff = getLeaderboardTitlePriority(right) - getLeaderboardTitlePriority(left);
        if (titleDiff !== 0) return titleDiff;

        const workingDiff = Number(!!right.isWorking) - Number(!!left.isWorking);
        if (workingDiff !== 0) return workingDiff;

        const questionsDiff = parseInteger(right.currentPeriodQuestions ?? right.questions, 0) - parseInteger(left.currentPeriodQuestions ?? left.questions, 0);
        if (questionsDiff !== 0) return questionsDiff;

        return String(left.username || "").localeCompare(String(right.username || ""), "tr");
    }

    function mergeForcedLocalLeaderboardEntry(leaderboardData) {
        const nextData = Array.isArray(leaderboardData) ? [...leaderboardData] : [];
        const localEntry = buildForcedLocalLeaderboardEntry();
        if (!localEntry) return nextData;

        const localIndex = nextData.findIndex(user => {
            if (currentUser?.uid) return user.uid === currentUser.uid;
            return user.uid === LOCAL_LEADERBOARD_PREVIEW_ID || (!!user.isLocalPreview && user.username === localEntry.username);
        });

        if (localIndex >= 0) {
            nextData[localIndex] = {
                ...nextData[localIndex],
                ...localEntry
            };
        } else {
            nextData.push(localEntry);
        }

        return nextData.sort(compareLeaderboardEntries);
    }

    function decodeFirestoreRestValue(value) {
        if (!value || typeof value !== "object") return null;
        if (Object.prototype.hasOwnProperty.call(value, "nullValue")) return null;
        if (Object.prototype.hasOwnProperty.call(value, "stringValue")) return String(value.stringValue || "");
        if (Object.prototype.hasOwnProperty.call(value, "booleanValue")) return !!value.booleanValue;
        if (Object.prototype.hasOwnProperty.call(value, "integerValue")) return parseInteger(value.integerValue, 0);
        if (Object.prototype.hasOwnProperty.call(value, "doubleValue")) return Number(value.doubleValue) || 0;
        if (Object.prototype.hasOwnProperty.call(value, "timestampValue")) return String(value.timestampValue || "");
        if (Object.prototype.hasOwnProperty.call(value, "referenceValue")) return String(value.referenceValue || "");
        if (Object.prototype.hasOwnProperty.call(value, "bytesValue")) return String(value.bytesValue || "");
        if (Object.prototype.hasOwnProperty.call(value, "geoPointValue")) {
            return {
                latitude: Number(value.geoPointValue?.latitude) || 0,
                longitude: Number(value.geoPointValue?.longitude) || 0
            };
        }
        if (Object.prototype.hasOwnProperty.call(value, "arrayValue")) {
            const values = Array.isArray(value.arrayValue?.values) ? value.arrayValue.values : [];
            return values.map(entry => decodeFirestoreRestValue(entry));
        }
        if (Object.prototype.hasOwnProperty.call(value, "mapValue")) {
            return decodeFirestoreRestFields(value.mapValue?.fields || {});
        }
        return null;
    }

    function decodeFirestoreRestFields(fields = {}) {
        const nextData = {};
        Object.entries(fields || {}).forEach(([key, value]) => {
            nextData[key] = decodeFirestoreRestValue(value);
        });
        return nextData;
    }

    function normalizeLeaderboardCloudDocs(rawDocs = []) {
        return (Array.isArray(rawDocs) ? rawDocs : [])
            .map(item => {
                const docId = String(item?.id || item?.name?.split("/").pop() || "").trim();
                if (!docId) return null;

                if (item && item.data && typeof item.data === "object") {
                    return {
                        id: docId,
                        data: item.data
                    };
                }

                if (item && item.fields && typeof item.fields === "object") {
                    return {
                        id: docId,
                        data: decodeFirestoreRestFields(item.fields)
                    };
                }

                return null;
            })
            .filter(Boolean);
    }

    function normalizeLiveLeaderboardDocData(rawData = {}, docId = "") {
        const safeSchedule = sanitizeScheduleData(rawData.schedule || {});
        const rawCurrentSessionTime = Math.max(0, parseInteger(rawData.currentSessionTime, 0));
        const rawIsWorking = !!rawData.isWorking || !!rawData.isRunning || isTimerRecordRunning(rawData.activeTimer);
        const cachedLegacyPresence = legacyWorkingPresenceByUserId.get(docId) || null;
        const sourceRecency = getLeaderboardSourceRecency(rawData);
        let legacyWorkingStartedAt = Math.max(0, parseInteger(rawData.legacyWorkingStartedAt, 0));

        if (rawIsWorking) {
            if (!legacyWorkingStartedAt && rawCurrentSessionTime > 0 && sourceRecency > 0) {
                legacyWorkingStartedAt = Math.max(0, sourceRecency - (rawCurrentSessionTime * 1000));
            }
            if (!legacyWorkingStartedAt && rawData.activeTimer) {
                legacyWorkingStartedAt = Math.max(0, parseInteger(rawData.activeTimer.startedAtMs, 0));
            }
            if (!legacyWorkingStartedAt && cachedLegacyPresence?.startedAtMs) {
                legacyWorkingStartedAt = parseInteger(cachedLegacyPresence.startedAtMs, 0);
            }
            if (!legacyWorkingStartedAt) {
                legacyWorkingStartedAt = sourceRecency || Date.now();
            }
            legacyWorkingPresenceByUserId.set(docId, { startedAtMs: legacyWorkingStartedAt });
        } else {
            legacyWorkingPresenceByUserId.delete(docId);
            legacyWorkingStartedAt = 0;
        }

        return {
            ...rawData,
            username: String(rawData.username || rawData.name || rawData.email?.split?.("@")?.[0] || "").trim(),
            schedule: safeSchedule,
            currentSessionTime: rawCurrentSessionTime,
            legacyWorkingStartedAt,
            isWorking: rawIsWorking,
            isRunning: rawIsWorking,
            totalTime: Math.max(parseInteger(rawData.totalTime, 0), parseInteger(rawData.totalWorkedSeconds, 0) * 1000, parseInteger(rawData.totalStudyTime, 0) * 1000),
            lastSyncTime: Math.max(parseInteger(rawData.lastSyncTime, 0), sourceRecency),
            lastTimerSyncAt: Math.max(parseInteger(rawData.lastTimerSyncAt, 0), parseInteger(rawData.lastSyncTime, 0), sourceRecency, legacyWorkingStartedAt)
        };
    }

    function normalizeLiveLeaderboardDocs(rawDocs = []) {
        return normalizeLeaderboardCloudDocs(rawDocs).map(item => ({
            id: item.id,
            data: normalizeLiveLeaderboardDocData(item.data || {}, item.id)
        }));
    }

    function mapUserSnapshotDocsToLeaderboardDocs(snapshotDocs = []) {
        return normalizeLeaderboardCloudDocs((Array.isArray(snapshotDocs) ? snapshotDocs : []).map(doc => {
            const rawData = doc.data() || {};
            const safeSchedule = sanitizeScheduleData(rawData.schedule || {});
            const questionCounters = buildQuestionCounterPayload(safeSchedule);
            const rawCurrentSessionTime = Math.max(0, parseInteger(rawData.currentSessionTime, 0));
            const rawIsWorking = !!rawData.isWorking || !!rawData.isRunning || isTimerRecordRunning(rawData.activeTimer);
            let legacyWorkingStartedAt = Math.max(0, parseInteger(rawData.legacyWorkingStartedAt, 0));
            const cachedLegacyPresence = legacyWorkingPresenceByUserId.get(doc.id) || null;

            if (rawIsWorking) {
                if (!legacyWorkingStartedAt && rawCurrentSessionTime > 0 && parseInteger(rawData.lastTimerSyncAt, 0) > 0) {
                    legacyWorkingStartedAt = Math.max(
                        0,
                        parseInteger(rawData.lastTimerSyncAt, 0) - (rawCurrentSessionTime * 1000)
                    );
                }
                if (!legacyWorkingStartedAt && cachedLegacyPresence?.startedAtMs) {
                    legacyWorkingStartedAt = parseInteger(cachedLegacyPresence.startedAtMs, 0);
                }
                if (!legacyWorkingStartedAt) {
                    legacyWorkingStartedAt = Date.now();
                }
                legacyWorkingPresenceByUserId.set(doc.id, { startedAtMs: legacyWorkingStartedAt });
            } else {
                legacyWorkingPresenceByUserId.delete(doc.id);
                legacyWorkingStartedAt = 0;
            }

            const currentWeekSeconds = Math.max(
                parseInteger(rawData.currentWeekSeconds, 0),
                parseInteger(rawData.weeklyStudyTime, 0),
                typeof getCurrentWeekTotalsFromSchedule === "function"
                    ? getCurrentWeekTotalsFromSchedule(safeSchedule).seconds
                    : 0
            );
            const totalWorkedSeconds = Math.max(
                parseInteger(rawData.totalWorkedSeconds, 0),
                parseInteger(rawData.totalStudyTime, 0),
                typeof calculateTotalWorkedSecondsFromSchedule === "function"
                    ? calculateTotalWorkedSecondsFromSchedule(safeSchedule)
                    : 0
            );
            const totalQuestionsAllTime = Math.max(
                parseInteger(rawData.totalQuestionsAllTime, 0),
                questionCounters.dailyQuestions,
                questionCounters.weeklyQuestions,
                typeof calculateTotalQuestionsFromSchedule === "function"
                    ? calculateTotalQuestionsFromSchedule(safeSchedule)
                    : 0
            );

            return {
                id: doc.id,
                data: {
                    ...rawData,
                    uid: doc.id,
                    email: rawData.email || "",
                    username: String(rawData.username || rawData.name || rawData.email?.split?.("@")?.[0] || "").trim(),
                    name: rawData.name || rawData.username || rawData.email?.split?.("@")?.[0] || "",
                    studyTrack: rawData.studyTrack || "",
                    selectedSubjects: typeof normalizeSelectedSubjects === "function"
                        ? normalizeSelectedSubjects(rawData.studyTrack || "", rawData.selectedSubjects || [])
                        : (rawData.selectedSubjects || []),
                    schedule: safeSchedule,
                    dailyQuestions: Math.max(
                        parseInteger(rawData.dailyQuestions, 0),
                        parseInteger(rawData.dailyQuestionCount, 0),
                        parseInteger(rawData.daily, 0),
                        questionCounters.dailyQuestions
                    ),
                    weeklyQuestions: Math.max(
                        parseInteger(rawData.weeklyQuestions, 0),
                        parseInteger(rawData.weeklyQuestionCount, 0),
                        parseInteger(rawData.weekly, 0),
                        questionCounters.weeklyQuestions
                    ),
                    weeklyStudyTime: Math.max(parseInteger(rawData.weeklyStudyTime, 0), currentWeekSeconds),
                    currentWeekSeconds,
                    totalWorkedSeconds,
                    totalStudyTime: Math.max(parseInteger(rawData.totalStudyTime, 0), totalWorkedSeconds),
                    totalTime: Math.max(parseInteger(rawData.totalTime, 0), totalWorkedSeconds * 1000),
                    totalQuestionsAllTime,
                    currentSessionTime: rawCurrentSessionTime,
                    legacyWorkingStartedAt,
                    activeTimer: rawData.activeTimer || null,
                    isWorking: rawIsWorking || isTimerRecordRunning(rawData.activeTimer),
                    isRunning: rawIsWorking || isTimerRecordRunning(rawData.activeTimer),
                    lastSyncTime: Math.max(parseInteger(rawData.lastSyncTime, 0), getLeaderboardSourceRecency(rawData)),
                    lastTimerSyncAt: Math.max(parseInteger(rawData.lastSyncTime, 0), getLeaderboardSourceRecency(rawData), legacyWorkingStartedAt)
                }
            };
        }));
    }

    function getLeaderboardSourceRecency(data = {}) {
        return Math.max(
            parseInteger(data?.lastSyncTime, 0),
            parseInteger(data?.lastTimerSyncAt, 0),
            parseInteger(data?.updatedAtMs, 0),
            parseInteger(data?.activeTimer?.lastSeenAtMs, 0),
            parseInteger(data?.activeTimer?.updatedAtMs, 0),
            parseInteger(data?.activeTimer?.startedAtMs, 0)
        );
    }

    function mergeLeaderboardSourceDocs(profileDocs = [], liveDocs = []) {
        const profileMap = new Map(normalizeLeaderboardCloudDocs(profileDocs).map(item => [item.id, item.data || {}]));
        const liveMap = new Map(normalizeLeaderboardCloudDocs(liveDocs).map(item => [item.id, item.data || {}]));
        const docIds = new Set([...profileMap.keys(), ...liveMap.keys()]);

        return normalizeLeaderboardCloudDocs([...docIds].map(docId => {
            const profileData = profileMap.get(docId) || {};
            const liveData = liveMap.get(docId) || {};
            const profileRecency = getLeaderboardSourceRecency(profileData);
            const liveRecency = getLeaderboardSourceRecency(liveData);
            const mergedData = {
                ...liveData,
                ...profileData
            };
            const profileSessionSeconds = Math.max(0, parseInteger(profileData.currentSessionTime, 0));
            const liveSessionSeconds = Math.max(0, parseInteger(liveData.currentSessionTime, 0));
            const profileTimer = profileData.activeTimer || null;
            const liveTimer = liveData.activeTimer || null;
            const profileLegacyWorkingStartedAt = Math.max(0, parseInteger(profileData.legacyWorkingStartedAt, 0));
            const liveLegacyWorkingStartedAt = Math.max(0, parseInteger(liveData.legacyWorkingStartedAt, 0));
            const profileTimerRecency = getLeaderboardSourceRecency({ activeTimer: profileTimer });
            const liveTimerRecency = getLeaderboardSourceRecency({ activeTimer: liveTimer });
            const liveTimerLooksFresher = !!liveTimer && (
                !profileTimer
                || liveTimerRecency >= profileTimerRecency
                || liveSessionSeconds > profileSessionSeconds
                || !!liveData.isWorking
            );

            mergedData.schedule = sanitizeScheduleData(profileData.schedule || liveData.schedule || {});
            mergedData.dailyStudyTime = Math.max(
                parseInteger(profileData.dailyStudyTime, 0),
                parseInteger(profileData.todayStudyTime, 0),
                parseInteger(profileData.todayWorkedSeconds, 0),
                parseInteger(liveData.dailyStudyTime, 0),
                parseInteger(liveData.todayStudyTime, 0),
                parseInteger(liveData.todayWorkedSeconds, 0)
            );
            mergedData.dailyStudyDateKey = profileData.dailyStudyDateKey
                || profileData.todayDateKey
                || liveData.dailyStudyDateKey
                || liveData.todayDateKey
                || "";
            mergedData.weeklyStudyTime = Math.max(
                parseInteger(profileData.weeklyStudyTime, 0),
                parseInteger(profileData.currentWeekSeconds, 0),
                parseInteger(liveData.weeklyStudyTime, 0),
                parseInteger(liveData.currentWeekSeconds, 0)
            );
            mergedData.currentWeekSeconds = Math.max(
                parseInteger(profileData.currentWeekSeconds, 0),
                parseInteger(profileData.weeklyStudyTime, 0),
                parseInteger(liveData.currentWeekSeconds, 0),
                parseInteger(liveData.weeklyStudyTime, 0)
            );
            mergedData.currentSessionTime = Math.max(profileSessionSeconds, liveSessionSeconds);
            mergedData.activeTimer = liveTimerLooksFresher
                ? (liveTimer || profileTimer || null)
                : (profileTimer || liveTimer || null);
            mergedData.lastTimerSyncAt = Math.max(profileRecency, liveRecency);
            mergedData.legacyWorkingStartedAt = Math.max(
                profileLegacyWorkingStartedAt,
                liveLegacyWorkingStartedAt,
                parseInteger(mergedData.activeTimer?.startedAtMs, 0),
                (mergedData.currentSessionTime > 0 && mergedData.lastTimerSyncAt > 0)
                    ? Math.max(0, mergedData.lastTimerSyncAt - (mergedData.currentSessionTime * 1000))
                    : 0
            );
            mergedData.totalWorkedSeconds = Math.max(
                parseInteger(profileData.totalWorkedSeconds, 0),
                parseInteger(profileData.totalStudyTime, 0),
                parseInteger(liveData.totalWorkedSeconds, 0),
                parseInteger(liveData.totalStudyTime, 0)
            );
            mergedData.totalStudyTime = Math.max(
                parseInteger(profileData.totalStudyTime, 0),
                parseInteger(profileData.totalWorkedSeconds, 0),
                parseInteger(liveData.totalStudyTime, 0),
                parseInteger(liveData.totalWorkedSeconds, 0)
            );
            mergedData.totalQuestionsAllTime = Math.max(
                parseInteger(profileData.totalQuestionsAllTime, 0),
                parseInteger(liveData.totalQuestionsAllTime, 0)
            );
            mergedData.isWorking = !!(
                profileData.isWorking
                || liveData.isWorking
                || isTimerRecordRunning(profileTimer)
                || isTimerRecordRunning(liveTimer)
                || (mergedData.currentSessionTime > 0 && mergedData.lastTimerSyncAt > 0 && (Date.now() - mergedData.lastTimerSyncAt) < REMOTE_TIMER_STALE_MS)
            );

            return {
                id: docId,
                data: mergedData
            };
        }));
    }

    function applyLeaderboardCloudDocs(rawDocs = []) {
        leaderboardRealtimeDocs = normalizeLeaderboardCloudDocs(rawDocs);

        if (currentUser?.uid) {
            const currentUserIndex = leaderboardRealtimeDocs.findIndex(item => item.id === currentUser.uid);
            const baseData = currentUserIndex >= 0
                ? (leaderboardRealtimeDocs[currentUserIndex]?.data || {})
                : (currentUserLiveDoc || {});
            const optimisticData = buildOptimisticCurrentUserData(baseData);
            if (currentUserIndex >= 0) {
                leaderboardRealtimeDocs[currentUserIndex] = { id: currentUser.uid, data: optimisticData };
            } else {
                leaderboardRealtimeDocs.push({ id: currentUser.uid, data: optimisticData });
            }
        }

        return leaderboardRealtimeDocs;
    }

    async function fetchLeaderboardDocsViaRest() {
        const projectId = String(firebase?.app?.()?.options?.projectId || "").trim();
        const apiKey = String(firebase?.app?.()?.options?.apiKey || "").trim();
        if (!projectId || !apiKey || typeof fetch !== "function") {
            return [];
        }

        const endpoint = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodeURIComponent(LEADERBOARD_COLLECTION)}?key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(endpoint, {
            method: "GET",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`leaderboard-rest-${response.status}`);
        }

        const payload = await response.json();
        return normalizeLeaderboardCloudDocs(payload?.documents || []);
    }

    async function fetchLeaderboardDocsFromUsersCollection() {
        const query = db.collection("users");
        let snapshot = null;

        try {
            snapshot = await query.get({ source: "server" });
        } catch (error) {
            snapshot = await query.get();
        }

        return mapUserSnapshotDocsToLeaderboardDocs(snapshot.docs);
    }

    async function fetchLeaderboardDocsFromLiveCollection() {
        return fetchLeaderboardDocsFromUsersCollection();
    }

    async function fetchLeaderboardDocsFromCloud() {
        return fetchLeaderboardDocsFromUsersCollection();
    }

    async function refreshLeaderboardCloudSnapshot(reason = "manual") {
        if (leaderboardCloudRefreshPromise) {
            return leaderboardCloudRefreshPromise;
        }

        leaderboardCloudRefreshPromise = fetchLeaderboardDocsFromCloud()
            .then(docs => {
                applyLeaderboardCloudDocs(docs);
                if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
                    renderLiveLeaderboardFromDocs();
                }
                return docs;
            })
            .catch(error => {
                console.error(`Lider tablosu ${reason} yenilenemedi:`, error);
                throw error;
            })
            .finally(() => {
                leaderboardCloudRefreshPromise = null;
            });

        return leaderboardCloudRefreshPromise;
    }

    function ensureLeaderboardCloudPolling() {
        return;
    }

    function stopLeaderboardCloudPolling() {
        if (!leaderboardCloudPollInterval) return;
        clearInterval(leaderboardCloudPollInterval);
        leaderboardCloudPollInterval = null;
    }

    function buildLeaderboardViewModelFromDocs() {
        return mergeForcedLocalLeaderboardEntry(getLeaderboardSourceDocs()
            .map(doc => {
                const data = doc.data || {};
                const seconds = getLiveLeaderboardSeconds(data);
                const questionBreakdown = getLeaderboardQuestionBreakdown(data);
                const currentPeriodQuestions = questionBreakdown.activeQuestions;
                const totalQuestions = Math.max(
                    parseInteger(data.totalQuestionsAllTime, 0),
                    typeof calculateTotalQuestionsFromSchedule === "function"
                        ? calculateTotalQuestionsFromSchedule(data.schedule || {})
                        : 0
                );
                const questions = currentPeriodQuestions;
                const currentWeekTotals = Math.max(
                    parseInteger(data.currentWeekSeconds, 0),
                    parseInteger(data.weeklyStudyTime, 0),
                    typeof getCurrentWeekTotalsFromSchedule === "function"
                        ? getCurrentWeekTotalsFromSchedule(data.schedule || {}).seconds
                        : seconds
                );
                const titleInfo = buildResolvedTitleInfo({
                    uid: doc.id,
                    schedule: sanitizeScheduleData(data.schedule || {}),
                    activeTimer: data.activeTimer || null,
                    selectedTitleId: getStoredSelectedTitleId(data),
                    titleAwards: getStoredTitleAwards(data)
                });
                const resolvedIsAdmin = !!data.isAdmin || (typeof isAdminIdentity === "function" && isAdminIdentity(data.username || "", data.email || ""));
                const resolvedUsername = String(data.username || data.name || data.email?.split?.("@")?.[0] || "Kullanici").trim();
                const liveSessionSnapshot = getLeaderboardLiveSessionSnapshot(data);

                const isWorking = currentLeaderboardTab === "daily"
                    && liveSessionSnapshot.isLive;
                const hasVisibleStats = seconds > 0 || isWorking;

                if (!resolvedUsername || !hasVisibleStats) return null;

                return {
                    uid: doc.id,
                    username: resolvedUsername,
                    email: data.email || "",
                    isAdmin: resolvedIsAdmin,
                    about: data.about || "",
                    profileImage: data.profileImage || "",
                    accountCreatedAt: data.accountCreatedAt || "",
                    studyTrack: data.studyTrack || "",
                    selectedSubjects: typeof normalizeSelectedSubjects === "function"
                        ? normalizeSelectedSubjects(data.studyTrack || "", data.selectedSubjects || [])
                        : (data.selectedSubjects || []),
                    selectedTitleId: titleInfo.selectedTitleId,
                    titleAwards: titleInfo.titleAwards,
                    schedule: sanitizeScheduleData(data.schedule || {}),
                    currentWeekSeconds: currentWeekTotals,
                    activeTimer: data.activeTimer || null,
                    titleInfo,
                    competitionScore: seconds,
                    seconds,
                    questions,
                    dailyQuestions: questionBreakdown.dailyQuestions,
                    weeklyQuestions: questionBreakdown.weeklyQuestions,
                    totalWorkedSeconds: Math.max(parseInteger(data.totalWorkedSeconds, 0), parseInteger(data.totalStudyTime, 0), typeof calculateTotalWorkedSecondsFromSchedule === "function" ? calculateTotalWorkedSecondsFromSchedule(data.schedule || {}) : 0),
                    currentPeriodQuestions,
                    totalQuestionsAllTime: totalQuestions,
                    isWorking,
                    isLocalPreview: !!data.isLocalPreview,
                    notes: typeof getPublicUserNotes === "function" ? getPublicUserNotes(data.notes || []) : []
                };
            })
            .filter(Boolean));
    }

    function prependPinnedLocalLeaderboardSummary(listContainer, leaderboardData = []) {
        if (!listContainer) return;

        const localEntry = buildForcedLocalLeaderboardEntry();
        if (!localEntry) return;
        const hasRealCurrentUserRow = Array.isArray(leaderboardData) && leaderboardData.some(user => {
            if (!user) return false;
            if (currentUser?.uid) {
                return user.uid === currentUser.uid && !user.isLocalPreview;
            }
            return false;
        });
        if (hasRealCurrentUserRow) return;

        const summaryCard = document.createElement("div");
        summaryCard.className = "leaderboard-item";
        summaryCard.style.border = "1px solid rgba(255,255,255,0.16)";
        summaryCard.style.background = "linear-gradient(135deg, rgba(76, 175, 80, 0.22), rgba(33, 150, 243, 0.18))";
        summaryCard.style.marginBottom = "10px";
        summaryCard.innerHTML = `
            <div class="leaderboard-rank">Sen</div>
            <img class="leaderboard-avatar" src="${escapeHtml(typeof getProfileImageSrc === "function" ? getProfileImageSrc(localEntry.profileImage, localEntry.username) : "")}" alt="${escapeHtml(localEntry.username)}">
            <div class="leaderboard-name-wrapper">
                <div class="leaderboard-name">${escapeHtml(localEntry.username)}</div>
                <div class="leaderboard-extra-badges">
                    <span class="leaderboard-questions" style="display:inline-flex; margin-top:4px; font-size:0.68em;">Bu Cihaz</span>
                </div>
            </div>
            <div class="leaderboard-stats">
                <div class="leaderboard-score">${typeof formatSeconds === "function" ? formatSeconds(localEntry.seconds) : localEntry.seconds}</div>
            </div>
        `;

        listContainer.appendChild(summaryCard);
    }

    function renderLiveLeaderboardFromDocs() {
        const listContainer = document.getElementById("leaderboard-list");
        if (!listContainer) return;

        const leaderboardData = buildLeaderboardViewModelFromDocs();
        leaderboardUserProfiles = {};
        listContainer.innerHTML = "";

        if (!leaderboardData.length) {
            listContainer.innerHTML = '<p style="text-align:center; opacity:0.7;">Henüz veri kaydedilmedi.</p>';
            return;
        }

        prependPinnedLocalLeaderboardSummary(listContainer, leaderboardData);

        leaderboardData.forEach((user, index) => {
            const item = document.createElement("div");
            item.className = "leaderboard-item";
            if (user.isAdmin) item.classList.add("admin-premium");
            if (index === 0) item.classList.add("rank-1");
            else if (index === 1) item.classList.add("rank-2");
            else if (index === 2) item.classList.add("rank-3");

            item.onclick = () => openLeaderboardProfile(user.uid);
            leaderboardUserProfiles[user.uid] = user;

            const adminBadgeHtml = user.isAdmin && typeof getAdminBadgeHtml === "function" ? getAdminBadgeHtml("small") : "";
            const titleBadgeHtml = user.titleInfo && typeof getTitleBadgeHtml === "function" ? getTitleBadgeHtml(user.titleInfo, "small") : "";
            const localBadgeHtml = user.isLocalPreview ? '<span class="leaderboard-questions" style="display:inline-flex; margin-top:4px; font-size:0.68em;">Bu Cihaz</span>' : "";

            item.innerHTML = `
                <div class="leaderboard-rank">#${index + 1}</div>
                <img class="leaderboard-avatar" src="${escapeHtml(typeof getProfileImageSrc === "function" ? getProfileImageSrc(user.profileImage, user.username) : "")}" alt="${escapeHtml(user.username)}">
                <div class="leaderboard-name-wrapper">
                    <div class="leaderboard-name">${escapeHtml(user.username)}</div>
                    <div class="leaderboard-extra-badges">${adminBadgeHtml}${titleBadgeHtml}${localBadgeHtml}</div>
                </div>
                <div class="leaderboard-stats">
                    <div class="leaderboard-score">${typeof formatSeconds === "function" ? formatSeconds(user.seconds) : user.seconds}</div>
                    ${user.isWorking ? '<div class="working-badge">Calisiyor</div>' : ""}
                </div>
            `;

            listContainer.appendChild(item);
        });
    }

    function subscribeRealtimeLeaderboard() {
        if (leaderboardRealtimeUnsubscribe || !currentUser?.uid) return;

        const listContainer = document.getElementById("leaderboard-list");
        if (listContainer && document.getElementById("leaderboard-panel")?.classList.contains("open")) {
            const localPreviewExists = buildLeaderboardViewModelFromDocs().length > 0;
            listContainer.innerHTML = localPreviewExists
                ? '<p style="text-align:center; opacity:0.7;">Canli veriler yuklenirken yerel ilerleme gosteriliyor...</p>'
                : '<p style="text-align:center; opacity:0.7;">Canli veriler yukleniyor...</p>';
        }

        const handleUsersSnapshot = snapshot => {
            const docs = mapUserSnapshotDocsToLeaderboardDocs(snapshot.docs || []);
            applyLeaderboardCloudDocs(docs);

            const currentUserDoc = (snapshot.docs || []).find(doc => doc.id === currentUser?.uid) || null;
            const currentData = currentUserDoc?.data?.() || {};
            const initialSync = !hasBootstrappedUsersRealtime;

            if (currentUserDoc) {
                syncCurrentUserLiveDoc(currentData, { silent: initialSync });
                applyAdminTimerResetFromUserData(currentData, { silent: initialSync });
            } else {
                currentUserLiveDoc = null;
            }

            if (initialSync) {
                requiresEmailVerification = !!currentData.requiresEmailVerification;
                if (requiresEmailVerification && !currentUser?.emailVerified) {
                    showVerificationGate({
                        email: currentUser?.email || "",
                        meta: "Bu yeni hesap icin email dogrulamasi bekleniyor."
                    });
                } else {
                    requiresEmailVerification = false;
                    hideVerificationGate();
                }
                bootstrapExtendedUserData(currentData);
                renderSchedule();
                renderMyNotesPanel();
                hasBootstrappedUsersRealtime = true;
            }

            if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
                renderLiveLeaderboardFromDocs();
            }
        };

        leaderboardRealtimeUnsubscribe = db.collection("users").onSnapshot(handleUsersSnapshot, error => {
            console.error("Canli users dinleyicisi basarisiz:", error);
            if (listContainer && document.getElementById("leaderboard-panel")?.classList.contains("open")) {
                listContainer.innerHTML = '<p style="text-align:center; color:#f87171;">Lider tablosu yuklenemedi.</p>';
            }
        });

        if (!leaderboardLiveInterval) {
            leaderboardLiveInterval = setInterval(() => {
                if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
                    renderLiveLeaderboardFromDocs();
                }
            }, 1000);
        }
    }

    function unsubscribeRealtimeLeaderboard() {
        if (leaderboardRealtimeUnsubscribe) {
            leaderboardRealtimeUnsubscribe();
            leaderboardRealtimeUnsubscribe = null;
        }
        hasBootstrappedUsersRealtime = false;
        leaderboardProfileSourceDocs = [];
        leaderboardLiveSourceDocs = [];
        stopLeaderboardCloudPolling();
        if (leaderboardLiveInterval) {
            clearInterval(leaderboardLiveInterval);
            leaderboardLiveInterval = null;
        }
    }

    function ensureNavyThemeButton() {
        const controls = document.querySelector(".theme-controls");
        if (!controls || controls.querySelector('[data-theme="navy"]')) return;

        const button = document.createElement("button");
        button.className = "theme-button";
        button.type = "button";
        button.dataset.theme = "navy";
        button.title = "Dark Navy Theme";
        button.innerHTML = '<i class="fas fa-water"></i>';
        button.addEventListener("click", () => setTheme("navy"));
        controls.appendChild(button);
    }

    function normalizeNoteFolders(rawFolders) {
        const folderMap = new Map();
        (Array.isArray(rawFolders) ? rawFolders : []).forEach((folder, index) => {
            const name = String(folder && folder.name ? folder.name : "").trim();
            if (!name) return;
            const id = String(folder && folder.id ? folder.id : `folder_${Date.now().toString(36)}_${index}`);
            if (folderMap.has(id)) return;
            folderMap.set(id, {
                id,
                name,
                createdAt: folder && folder.createdAt ? folder.createdAt : new Date().toISOString()
            });
        });

        return [...folderMap.values()];
    }

    function getFolderName(folderId) {
        const match = normalizeNoteFolders(noteFolders).find(folder => folder.id === folderId);
        return match ? match.name : "Genel";
    }

    function renderNoteFolderControls() {
        const folderBar = document.getElementById("notes-folder-bar");
        const folderSelect = document.getElementById("my-note-folder-select");
        if (!folderBar || !folderSelect) return;

        const folders = normalizeNoteFolders(noteFolders);
        noteFolders = folders;
        const normalizedNotes = normalizeUserNotes(userNotes || []);

        folderBar.innerHTML = [
            `<button type="button" class="notes-folder-chip ${activeNoteFolderId === NOTE_FOLDER_ALL_ID ? "is-active" : ""}" data-folder-id="${NOTE_FOLDER_ALL_ID}">Tümü (${normalizedNotes.length})</button>`,
            ...folders.map(folder => {
                const count = normalizedNotes.filter(note => (note.folderId || NOTE_FOLDER_DEFAULT_ID) === folder.id).length;
                return `<button type="button" class="notes-folder-chip ${activeNoteFolderId === folder.id ? "is-active" : ""}" data-folder-id="${folder.id}">${escapeHtml(folder.name)} (${count})</button>`;
            })
        ].join("");

        folderBar.querySelectorAll("[data-folder-id]").forEach(button => {
            button.addEventListener("click", () => {
                activeNoteFolderId = button.dataset.folderId || NOTE_FOLDER_ALL_ID;
                renderMyNotesPanel();
            });
        });

        folderSelect.innerHTML = folders.map(folder => `<option value="${folder.id}">${escapeHtml(folder.name)}</option>`).join("");
    }

    function ensureNotesFolderUi() {
        const editorFields = document.querySelector(".notes-editor-fields");
        const listPanel = document.querySelector(".notes-list-panel");
        if (!editorFields || !listPanel) return;

        if (!document.getElementById("notes-folder-toolbar")) {
            const toolbar = document.createElement("div");
            toolbar.id = "notes-folder-toolbar";
            toolbar.className = "notes-folder-toolbar";
            toolbar.innerHTML = `
                <div class="notes-folder-select-row">
                    <select id="my-note-folder-select"></select>
                    <button id="note-folder-toggle-create-btn" type="button" style="background-color: var(--accent-color); color: var(--header-text);">
                        <i class="fas fa-folder-plus"></i> Klasör
                    </button>
                </div>
                <div id="notes-folder-create-row" class="notes-folder-create-row is-hidden">
                    <input id="note-folder-name-input" type="text" maxlength="60" placeholder="Yeni klasör adı">
                    <button id="note-folder-create-btn" type="button" style="background-color: var(--countdown-fill); color: var(--header-text);">
                        Oluştur
                    </button>
                    <button id="note-folder-cancel-btn" type="button" style="background-color: var(--button-bg); color: var(--header-text);">
                        İptal
                    </button>
                </div>
            `;
            editorFields.insertBefore(toolbar, editorFields.firstChild);

            document.getElementById("note-folder-toggle-create-btn")?.addEventListener("click", () => {
                document.getElementById("notes-folder-create-row")?.classList.remove("is-hidden");
                document.getElementById("note-folder-name-input")?.focus();
            });

            document.getElementById("note-folder-cancel-btn")?.addEventListener("click", () => {
                document.getElementById("notes-folder-create-row")?.classList.add("is-hidden");
                const input = document.getElementById("note-folder-name-input");
                if (input) input.value = "";
            });

            document.getElementById("note-folder-create-btn")?.addEventListener("click", () => {
                const input = document.getElementById("note-folder-name-input");
                const folderName = String(input?.value || "").trim();
                if (folderName.length < 2) {
                    safeShowAlert("Klasör adı en az 2 karakter olmalı.");
                    return;
                }
                if (normalizeNoteFolders(noteFolders).some(folder => folder.name.toLocaleLowerCase("tr-TR") === folderName.toLocaleLowerCase("tr-TR"))) {
                    safeShowAlert("Bu isimde bir klasör zaten var.");
                    return;
                }
                const folderId = `folder_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
                noteFolders = [...normalizeNoteFolders(noteFolders), { id: folderId, name: folderName, createdAt: new Date().toISOString() }];
                activeNoteFolderId = folderId;
                if (input) input.value = "";
                document.getElementById("notes-folder-create-row")?.classList.add("is-hidden");
                saveData();
                renderMyNotesPanel();
                safeShowAlert("Klasör oluşturuldu.", "success");
            });
        }

        if (!document.getElementById("notes-folder-bar")) {
            const bar = document.createElement("div");
            bar.id = "notes-folder-bar";
            bar.className = "notes-folder-bar";
            listPanel.querySelector(".notes-panel-header")?.insertAdjacentElement("afterend", bar);
        }

        renderNoteFolderControls();
    }

    function filterNotesByActiveFolder(notes) {
        if (activeNoteFolderId === NOTE_FOLDER_ALL_ID) return notes;
        return notes.filter(note => (note.folderId || NOTE_FOLDER_DEFAULT_ID) === activeNoteFolderId);
    }

    function ensureSubjectQuestionModal() {
        if (document.getElementById("subject-questions-modal")) return;

        const modal = document.createElement("div");
        modal.id = "subject-questions-modal";
        modal.className = "modal-overlay";
        modal.innerHTML = `
            <div class="subject-questions-modal-card">
                <div class="subject-questions-header">
                    <div>
                        <h3>Ders Bazlı Soru Takibi</h3>
                        <p>Her ders için soru sayısını ayrı gir. Toplam otomatik hesaplanır ve 500 sınırını aşamaz.</p>
                    </div>
                    <button type="button" id="close-subject-questions-btn" style="background: none; box-shadow: none; color: var(--text-color);">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div id="subject-questions-grid" class="subject-questions-grid"></div>
                <div id="subject-questions-total" class="subject-questions-total">
                    <span>Toplam</span>
                    <strong id="subject-questions-total-value">0</strong>
                </div>
                <div id="subject-questions-error" class="question-validation-message is-hidden"></div>
                <div class="subject-questions-actions">
                    <button id="subject-questions-cancel-btn" type="button" style="background-color: var(--button-bg); color: var(--header-text);">İptal</button>
                    <button id="subject-questions-save-btn" type="button" style="background-color: var(--accent-color); color: var(--header-text);">Kaydet</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const close = () => {
            modal.style.display = "none";
            activeQuestionDayIdx = null;
            if (typeof syncBodyModalLock === "function") syncBodyModalLock();
        };

        modal.addEventListener("click", event => {
            if (event.target === modal) close();
        });
        modal.querySelector("#close-subject-questions-btn")?.addEventListener("click", close);
        modal.querySelector("#subject-questions-cancel-btn")?.addEventListener("click", close);
        modal.querySelector("#subject-questions-save-btn")?.addEventListener("click", saveSubjectQuestionBreakdown);
    }

    function updateSubjectQuestionModalTotal() {
        const inputs = Array.from(document.querySelectorAll(".subject-question-row input"));
        const total = inputs.reduce((sum, input) => sum + clampNumber(input.value, 0, QUESTION_LIMIT), 0);
        const totalValue = document.getElementById("subject-questions-total-value");
        const errorNode = document.getElementById("subject-questions-error");

        if (totalValue) totalValue.textContent = String(total);

        if (errorNode) {
            if (total > QUESTION_LIMIT) {
                errorNode.textContent = getQuestionLimitError();
                errorNode.classList.remove("is-hidden");
            } else {
                errorNode.textContent = "";
                errorNode.classList.add("is-hidden");
            }
        }

        return total;
    }

    function openSubjectQuestionModal(dayIdx) {
        ensureSubjectQuestionModal();
        activeQuestionDayIdx = dayIdx;

        const modal = document.getElementById("subject-questions-modal");
        const grid = document.getElementById("subject-questions-grid");
        if (!modal || !grid) return;

        const weekKey = getWeekKey(currentWeekStart);
        const dayData = ensureWeekDay(weekKey, dayIdx);
        const subjects = getTrackedSubjectIds(dayData);
        const existingMap = normalizeSubjectQuestionMap(dayData.subjectQuestions || {});

        grid.innerHTML = subjects.map(subjectId => `
            <div class="subject-question-row">
                <label for="subject-question-${subjectId}">${escapeHtml(getSubjectLabel(subjectId))}</label>
                <input type="number" id="subject-question-${subjectId}" data-subject-id="${subjectId}" min="0" max="${QUESTION_LIMIT}" value="${existingMap[subjectId] || 0}">
            </div>
        `).join("");

        grid.querySelectorAll("input").forEach(input => {
            input.addEventListener("input", () => {
                input.value = String(clampNumber(input.value, 0, QUESTION_LIMIT));
                updateSubjectQuestionModalTotal();
            });
        });

        updateSubjectQuestionModalTotal();
        modal.style.display = "flex";
        if (typeof syncBodyModalLock === "function") syncBodyModalLock();
    }

    function saveSubjectQuestionBreakdown() {
        if (activeQuestionDayIdx === null) return;

        const total = updateSubjectQuestionModalTotal();
        if (total > QUESTION_LIMIT) {
            safeShowAlert(getQuestionLimitError());
            return;
        }

        const weekKey = getWeekKey(currentWeekStart);
        const dayData = ensureWeekDay(weekKey, activeQuestionDayIdx);
        const subjectMap = {};

        document.querySelectorAll(".subject-question-row input").forEach(input => {
            const subjectId = input.dataset.subjectId || FREE_GENERAL_SUBJECT;
            const amount = clampNumber(input.value, 0, QUESTION_LIMIT);
            if (amount > 0) subjectMap[subjectId] = amount;
        });

        dayData.subjectQuestions = subjectMap;
        dayData.questions = total;
        scheduleData[weekKey][activeQuestionDayIdx] = ensureDayObject(dayData);
        totalQuestionsAllTime = typeof calculateTotalQuestionsFromSchedule === "function"
            ? calculateTotalQuestionsFromSchedule(scheduleData)
            : totalQuestionsAllTime;

        saveData({ authorized: true, immediate: true });
        refreshLeaderboardOptimistically();
        renderSchedule();
        document.getElementById("subject-questions-modal").style.display = "none";
        activeQuestionDayIdx = null;
        if (typeof syncBodyModalLock === "function") syncBodyModalLock();
        safeShowAlert("Ders bazlı soru dağılımı kaydedildi.", "success");
    }

    function setQuestionValidation(dayIdx, message = "") {
        const input = document.getElementById(`q-input-${dayIdx}`);
        const box = input?.closest(".question-input-box");
        if (!box) return;

        let node = box.querySelector(".question-validation-message");
        if (!node) {
            node = document.createElement("div");
            node.className = "question-validation-message is-hidden";
            box.appendChild(node);
        }

        if (message) {
            node.textContent = message;
            node.classList.remove("is-hidden");
        } else {
            node.textContent = "";
            node.classList.add("is-hidden");
        }
    }

    function getDayQuestionSubjectOptions(dayData) {
        const ordered = [];
        const seen = new Set();

        const addSubject = (subjectId) => {
            if (!subjectId || seen.has(subjectId)) return;
            seen.add(subjectId);
            ordered.push(subjectId);
        };

        (dayData?.tasks || []).forEach(task => {
            const matches = typeof matchTaskSubjects === "function"
                ? matchTaskSubjects(task.text || "", getTrackedSubjectIds(dayData))
                : [];
            if (matches.length) {
                matches.forEach(addSubject);
            }
        });

        getTrackedSubjectIds(dayData).forEach(addSubject);

        if (!ordered.length) {
            addSubject(FREE_GENERAL_SUBJECT);
        }

        return ordered;
    }

    function renderQuestionTrackingEnhancements() {
        const weekKey = getWeekKey(currentWeekStart);

        for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
            const input = document.getElementById(`q-input-${dayIdx}`);
            if (!input) continue;

            input.min = "0";
            input.max = String(QUESTION_LIMIT);
            input.inputMode = "numeric";
            input.placeholder = "Soru sayısı girin";
            input.oninput = () => setQuestionValidation(dayIdx, "");
            if (document.activeElement !== input) {
                input.value = "";
            }

            const dayData = ensureWeekDay(weekKey, dayIdx);
            const subjectOptions = getDayQuestionSubjectOptions(dayData);
            const buttonGroup = input.closest(".question-input-box")?.querySelector(".question-btn-group");
            const summaryRoot = input.closest(".question-input-box");
            const questionRow = input.closest(".question-input-row");

            const oldBreakdownButton = buttonGroup?.querySelector(".subject-breakdown-btn");
            if (oldBreakdownButton) oldBreakdownButton.remove();

            if (questionRow) {
                let select = questionRow.querySelector(".question-subject-select");
                if (!select) {
                    select = document.createElement("select");
                    select.className = "question-subject-select";
                    select.id = `q-subject-${dayIdx}`;
                    questionRow.insertBefore(select, input);
                }

                const currentValue = select.value;
                select.innerHTML = subjectOptions.map(subjectId => `
                    <option value="${subjectId}">${escapeHtml(getSubjectLabel(subjectId))}</option>
                `).join("");

                if (subjectOptions.includes(currentValue)) {
                    select.value = currentValue;
                }
            }

            let summary = summaryRoot?.querySelector(".subject-question-summary");
            if (!summary && summaryRoot) {
                summary = document.createElement("div");
                summary.className = "subject-question-summary";
                summaryRoot.appendChild(summary);
            }

            if (summary) {
                summary.innerHTML = subjectOptions.length
                    ? subjectOptions.map(subjectId => {
                        const amount = parseInteger(dayData.subjectQuestions?.[subjectId], 0);
                        return `
                        <span class="subject-question-pill">
                            ${escapeHtml(getSubjectLabel(subjectId))}
                            <strong>${amount}</strong>
                        </span>
                    `;
                    }).join("")
                    : '<span class="subject-question-empty">Henüz ders bazlı soru dağılımı eklenmedi.</span>';
            }

            setQuestionValidation(dayIdx, "");
        }
    }

    async function resendVerificationEmail() {
        if (!currentUser) {
            setVerificationMeta("Doğrulama bağlantısını tekrar göndermek için hesabın açık olmalı.");
            return;
        }

        const cooldownUntil = parseInteger(localStorage.getItem(VERIFY_COOLDOWN_KEY), 0);
        if (cooldownUntil > Date.now()) {
            refreshVerificationCooldownUI();
            return;
        }

        const resendButton = document.getElementById("email-verification-resend-btn");
        if (resendButton) {
            resendButton.disabled = true;
            resendButton.innerHTML = "Gönderiliyor...";
        }

        try {
            await currentUser.reload();
            if (currentUser.emailVerified) {
                setVerificationMeta("Email doğrulandı. Giriş alanı açılıyor.", true);
                hideVerificationGate();
                return;
            }

            await currentUser.sendEmailVerification();
            localStorage.setItem(VERIFY_COOLDOWN_KEY, String(Date.now() + VERIFY_COOLDOWN_MS));
            setVerificationMeta("Doğrulama bağlantısı tekrar gönderildi. Spam/junk klasörünü de kontrol edin.", true);
            safeShowAlert("Doğrulama bağlantısı tekrar gönderildi. Spam/junk klasörünü de kontrol edin.", "success");
        } catch (error) {
            console.error("Email doğrulama yeniden gönderilemedi:", error);
            setVerificationMeta("Bağlantı gönderilirken bir hata oluştu. Lütfen tekrar dene.");
        } finally {
            refreshVerificationCooldownUI();
        }
    }

    function updateTimerStatus(statusText) {
        const statusNode = document.getElementById("timer-status");
        if (!statusNode) return;
        statusNode.textContent = statusText;
        statusNode.style.display = statusText ? "" : "none";
    }

    function renderTimerUi() {
        const content = document.querySelector("#pomodoro-modal .pomodoro-content");
        if (!content) return;

        content.classList.toggle("is-stopwatch-mode", timerState.mode === "stopwatch");
        updateTimerButtons();
        updateTimerSessionPill();

        const displaySeconds = getTimerDisplaySeconds();
        timeRemaining = displaySeconds;
        renderSegmentedTimer(displaySeconds);

        if (timerState.session?.isRunning) {
            updateTimerStatus(timerState.mode === "stopwatch"
                ? "Kronometre calisiyor. Sure canli olarak takip ediliyor."
                : "Pomodoro calisiyor. Sure canli olarak takip ediliyor.");
        } else {
            updateTimerStatus("");
        }

        updateLiveStudyPreview();
    }

    function getDayQuestionSubjectOptions(dayData) {
        const ordered = [];
        const seen = new Set();

        (dayData?.tasks || []).forEach(task => {
            const taskLabel = String(task?.text || "").trim();
            if (!taskLabel || seen.has(taskLabel)) return;
            seen.add(taskLabel);
            ordered.push(taskLabel);
        });

        return ordered;
    }

    function getQuestionTrackingOptions(dayData) {
        const taskOptions = getDayQuestionSubjectOptions(dayData);
        const rawMap = normalizeSubjectQuestionMap(dayData?.subjectQuestions || {});

        if (!taskOptions.length) {
            return [];
        }

        if (rawMap[FREE_GENERAL_SUBJECT] > 0 && !taskOptions.includes(FREE_GENERAL_SUBJECT)) {
            return [...taskOptions, FREE_GENERAL_SUBJECT];
        }

        return taskOptions;
    }

    function getQuestionTrackingLabel(optionValue) {
        return optionValue === FREE_GENERAL_SUBJECT ? "Genel" : optionValue;
    }

    function normalizeTaskQuestionMap(dayData) {
        const taskOptions = getDayQuestionSubjectOptions(dayData);
        const rawMap = normalizeSubjectQuestionMap(dayData?.subjectQuestions || {});
        if (!taskOptions.length) return rawMap;

        const optionSet = new Set(taskOptions);
        optionSet.add(FREE_GENERAL_SUBJECT);
        const nextMap = {};

        Object.entries(rawMap).forEach(([key, amount]) => {
            const normalizedAmount = clampNumber(amount, 0, QUESTION_LIMIT);
            if (normalizedAmount <= 0) return;
            if (optionSet.has(key)) {
                nextMap[key] = normalizedAmount;
            }
        });

        return normalizeSubjectQuestionMap(nextMap);
    }

    function syncDayQuestionState(dayData) {
        if (!dayData || typeof dayData !== "object") return dayData;
        const normalizedDay = ensureDayObject(dayData);
        const normalizedMap = normalizeTaskQuestionMap(normalizedDay);
        const normalizedTotal = Object.values(normalizedMap || {}).reduce((sum, amount) => sum + parseInteger(amount, 0), 0);

        if (normalizedTotal > 0 || parseInteger(normalizedDay.questions, 0) <= 0) {
            dayData.subjectQuestions = normalizedMap;
            dayData.questions = normalizedTotal;
            return dayData;
        }

        dayData.subjectQuestions = normalizeSubjectQuestionMap(normalizedDay.subjectQuestions || {});
        dayData.questions = parseInteger(normalizedDay.questions, 0);
        return dayData;
    }

    function clearTaskDragVisualState() {
        document.querySelectorAll(".task-item.dragging, .task-item.is-drop-target, .task-item.is-drop-before, .task-item.is-drop-after").forEach(node => {
            node.classList.remove("dragging", "is-drop-target", "is-drop-before", "is-drop-after");
            delete node.dataset.dropPosition;
        });
    }

    function moveTaskToIndex(dayIdx, fromIdx, toIdx) {
        const weekKey = getWeekKey(currentWeekStart);
        const dayData = ensureWeekDay(weekKey, dayIdx);
        const tasks = Array.isArray(dayData.tasks) ? dayData.tasks : [];
        if (tasks.length < 2) return;

        const sourceIndex = clampNumber(fromIdx, 0, tasks.length - 1);
        const targetIndex = clampNumber(toIdx, 0, tasks.length - 1);
        if (sourceIndex === targetIndex) return;

        const [movedTask] = tasks.splice(sourceIndex, 1);
        tasks.splice(targetIndex, 0, movedTask);
        dayData.tasks = tasks;
        scheduleData[weekKey][dayIdx] = syncDayQuestionState(ensureDayObject(dayData));
        saveData();
        renderSchedule();
    }

    function getSafeSelectedTask(dayData, currentValue = "") {
        const taskOptions = getQuestionTrackingOptions(dayData);
        if (!taskOptions.length) return "";
        return taskOptions.includes(currentValue) ? currentValue : taskOptions[0];
    }

    function getTaskQuestionSummaryHtml(dayData, taskOptions) {
        const taskQuestionMap = normalizeTaskQuestionMap(dayData);
        const summaryOptions = Array.isArray(taskOptions) && taskOptions.length
            ? taskOptions
            : getQuestionTrackingOptions(dayData);
        const solvedEntries = summaryOptions
            .map(taskLabel => ({
                taskLabel,
                displayLabel: getQuestionTrackingLabel(taskLabel),
                amount: parseInteger(taskQuestionMap[taskLabel], 0)
            }))
            .filter(entry => entry.amount > 0);

        if (!solvedEntries.length) {
            return '<span class="subject-question-empty">Henüz soru kaydı eklenmedi.</span>';
        }

        return solvedEntries.map(({ displayLabel, amount }) => `
            <span class="subject-question-pill">
                ${escapeHtml(displayLabel)}
                <strong>${amount}</strong>
            </span>
        `).join("");
    }

    function ensureTaskDecorations(dayIdx, dayData) {
        const taskList = document.getElementById(`task-list-${dayIdx}`);
        if (!taskList) return;

        const taskCount = Array.isArray(dayData?.tasks) ? dayData.tasks.length : 0;
        [...taskList.children].forEach((item, taskIdx) => {
            if (!item.classList.contains("task-item")) return;

            item.ondrop = event => handleDrop(event, dayIdx, taskIdx);
            item.ondragenter = () => item.classList.add("is-drop-target");
            item.ondragleave = event => {
                if (!item.contains(event.relatedTarget)) {
                    item.classList.remove("is-drop-target", "is-drop-before", "is-drop-after");
                    delete item.dataset.dropPosition;
                }
            };
            item.ondragend = clearTaskDragVisualState;
            item.ondragover = event => {
                handleDragOver(event);
                const rect = item.getBoundingClientRect();
                const dropAfter = (event.clientY - rect.top) > (rect.height / 2);
                item.dataset.dropPosition = dropAfter ? "after" : "before";
                item.classList.add("is-drop-target");
                item.classList.toggle("is-drop-before", !dropAfter);
                item.classList.toggle("is-drop-after", dropAfter);
            };

            let orderInput = item.querySelector(".task-order-input");
            if (!orderInput) {
                orderInput = document.createElement("input");
                orderInput.type = "number";
                orderInput.className = "task-order-input";
                orderInput.inputMode = "numeric";
                item.insertBefore(orderInput, item.firstChild);
            }

            orderInput.min = "1";
            orderInput.max = String(Math.max(taskCount, 1));
            orderInput.value = String(taskIdx + 1);
            orderInput.onclick = event => event.stopPropagation();
            orderInput.onfocus = () => orderInput.select();
            orderInput.title = "Sıra numarası";
            orderInput.setAttribute("aria-label", `${String(dayData?.tasks?.[taskIdx]?.text || "Görev")} sırası`);
            orderInput.onchange = () => {
                const requestedOrder = clampNumber(orderInput.value, 1, Math.max(taskCount, 1));
                orderInput.value = String(requestedOrder);
                moveTaskToIndex(dayIdx, taskIdx, requestedOrder - 1);
            };

            const contentWrapper = item.querySelector(".task-content-wrapper");
            if (!contentWrapper) return;

            let badge = contentWrapper.querySelector(".task-question-badge");
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "task-question-badge";
                const deleteIcon = contentWrapper.querySelector(".fa-times");
                if (deleteIcon) {
                    contentWrapper.insertBefore(badge, deleteIcon);
                } else {
                    contentWrapper.appendChild(badge);
                }
            }

            const taskLabel = String(dayData?.tasks?.[taskIdx]?.text || "").trim();
            const solvedCount = parseInteger(normalizeTaskQuestionMap(dayData)?.[taskLabel], 0);
            badge.textContent = `${solvedCount} soru`;
            badge.classList.toggle("is-hidden", solvedCount <= 0);
            item.title = "Soldaki sayı ile ya da sürükleyerek sıralayabilirsin.";
        });
    }

    function renderQuestionTrackingEnhancements() {
        const weekKey = getWeekKey(currentWeekStart);

        for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
            const input = document.getElementById(`q-input-${dayIdx}`);
            if (!input) continue;

            input.min = "0";
            input.max = String(QUESTION_LIMIT);
            input.inputMode = "numeric";
            input.placeholder = "Soru sayısını girin";
            input.oninput = () => setQuestionValidation(dayIdx, "");
            if (document.activeElement !== input) {
                input.value = "";
            }

            const dayData = syncDayQuestionState(ensureWeekDay(weekKey, dayIdx));
            const taskOptions = getQuestionTrackingOptions(dayData);
            const buttonGroup = input.closest(".question-input-box")?.querySelector(".question-btn-group");
            const summaryRoot = input.closest(".question-input-box");
            const questionRow = input.closest(".question-input-row");

            input.disabled = !taskOptions.length;
            input.placeholder = taskOptions.length ? "Soru sayısını girin" : "Önce görev ekleyin";
            if (!taskOptions.length && document.activeElement !== input) {
                input.value = "";
            }

            buttonGroup?.querySelector(".subject-breakdown-btn")?.remove();

            if (questionRow) {
                let select = questionRow.querySelector(".question-subject-select");
                if (!taskOptions.length) {
                    select?.remove();
                } else {
                    if (!select) {
                        select = document.createElement("select");
                        select.className = "question-subject-select";
                        select.id = `q-subject-${dayIdx}`;
                    }
                    questionRow.appendChild(select);

                    const selectedValue = select.value;
                    select.innerHTML = taskOptions.map(taskLabel => `
                        <option value="${escapeHtml(taskLabel)}">${escapeHtml(getQuestionTrackingLabel(taskLabel))}</option>
                    `).join("");
                    select.disabled = false;
                    select.value = getSafeSelectedTask(dayData, selectedValue);
                }
            }

            let summary = summaryRoot?.querySelector(".subject-question-summary");
            if (!summary && summaryRoot) {
                summary = document.createElement("div");
                summary.className = "subject-question-summary";
                summaryRoot.appendChild(summary);
            }

            if (summary) {
                if (!taskOptions.length) {
                    summary.innerHTML = "";
                    summary.style.display = "none";
                } else {
                    summary.style.display = "";
                    summary.innerHTML = getTaskQuestionSummaryHtml(dayData, taskOptions);
                }
            }

            ensureTaskDecorations(dayIdx, dayData);
            setQuestionValidation(dayIdx, "");
        }
    }

    function renderLiveLeaderboardFromDocs() {
        const listContainer = document.getElementById("leaderboard-list");
        if (!listContainer) return;

        const leaderboardData = buildLeaderboardViewModelFromDocs();
        leaderboardUserProfiles = {};
        listContainer.innerHTML = "";

        if (!leaderboardData.length) {
            listContainer.innerHTML = '<p style="text-align:center; opacity:0.7;">Henüz veri kaydedilmedi.</p>';
            return;
        }

        prependPinnedLocalLeaderboardSummary(listContainer, leaderboardData);

        leaderboardData.forEach((user, index) => {
            const item = document.createElement("div");
            item.className = "leaderboard-item";
            if (user.isAdmin) item.classList.add("admin-premium");
            if (index === 0) item.classList.add("rank-1");
            else if (index === 1) item.classList.add("rank-2");
            else if (index === 2) item.classList.add("rank-3");

            item.onclick = () => openLeaderboardProfile(user.uid);
            leaderboardUserProfiles[user.uid] = user;

            const adminBadgeHtml = user.isAdmin && typeof getAdminBadgeHtml === "function" ? getAdminBadgeHtml("small") : "";
            const titleBadgeHtml = user.titleInfo && typeof getTitleBadgeHtml === "function" ? getTitleBadgeHtml(user.titleInfo, "small") : "";
            const localBadgeHtml = user.isLocalPreview ? '<span class="leaderboard-questions" style="display:inline-flex; margin-top:4px; font-size:0.68em;">Bu Cihaz</span>' : "";

            item.innerHTML = `
                <div class="leaderboard-rank">#${index + 1}</div>
                <img class="leaderboard-avatar" src="${escapeHtml(typeof getProfileImageSrc === "function" ? getProfileImageSrc(user.profileImage, user.username) : "")}" alt="${escapeHtml(user.username)}">
                <div class="leaderboard-name-wrapper">
                    <div class="leaderboard-name">${escapeHtml(user.username)}</div>
                    <div class="leaderboard-extra-badges">${adminBadgeHtml}${titleBadgeHtml}${localBadgeHtml}</div>
                </div>
                <div class="leaderboard-stats">
                    <div class="leaderboard-score">${typeof formatSeconds === "function" ? formatSeconds(user.seconds) : user.seconds}</div>
                    ${user.isWorking ? '<div class="working-badge">Calisiyor</div>' : ""}
                </div>
            `;

            listContainer.appendChild(item);
        });
    }

    function patchQuestionTracking() {
        updateQuestions = function(dayIdx) {
            const input = document.getElementById(`q-input-${dayIdx}`);
            const select = document.getElementById(`q-subject-${dayIdx}`);
            if (!input) return;

            const rawValue = parseInteger(input.value, 0);
            if (rawValue > QUESTION_LIMIT) {
                input.value = String(QUESTION_LIMIT);
                setQuestionValidation(dayIdx, getQuestionLimitError());
                safeShowAlert(getQuestionLimitError());
                return;
            }

            const value = clampNumber(rawValue, 0, QUESTION_LIMIT);
            if (value <= 0) {
                input.value = "";
                setQuestionValidation(dayIdx, "");
                return;
            }

            const weekKey = getWeekKey(currentWeekStart);
            const dayData = syncDayQuestionState(ensureWeekDay(weekKey, dayIdx));
            const taskLabel = getSafeSelectedTask(dayData, select?.value || "");
            if (!taskLabel) {
                setQuestionValidation(dayIdx, "Önce görev eklemelisiniz");
                safeShowAlert("Önce görev ekleyin, sonra soru girin.");
                return;
            }

            const otherQuestionsTotal = Object.entries(dayData.subjectQuestions || {})
                .filter(([key]) => key !== taskLabel)
                .reduce((sum, [, amount]) => sum + parseInteger(amount, 0), 0);

            if ((otherQuestionsTotal + value) > QUESTION_LIMIT) {
                setQuestionValidation(dayIdx, getQuestionLimitError());
                safeShowAlert(getQuestionLimitError());
                return;
            }

            dayData.subjectQuestions = normalizeTaskQuestionMap(dayData);
            dayData.subjectQuestions[taskLabel] = value;
            syncDayQuestionState(dayData);
            saveData();
            input.value = "";
            setQuestionValidation(dayIdx, "");
            renderSchedule();
            safeShowAlert(`${getQuestionTrackingLabel(taskLabel)} için soru sayısı ${value} olarak kaydedildi.`, "success");
        };

        clearQuestions = function(dayIdx) {
            const weekKey = getWeekKey(currentWeekStart);
            const dayData = syncDayQuestionState(ensureWeekDay(weekKey, dayIdx));
            const select = document.getElementById(`q-subject-${dayIdx}`);
            const taskLabel = getSafeSelectedTask(dayData, select?.value || "");

            if (!taskLabel) {
                dayData.subjectQuestions = {};
                dayData.questions = 0;
                saveData();
                renderSchedule();
                return;
            }

            dayData.subjectQuestions = normalizeTaskQuestionMap(dayData);
            delete dayData.subjectQuestions[taskLabel];
            syncDayQuestionState(dayData);
            saveData();
            renderSchedule();
            safeShowAlert(`${taskLabel} için kaydedilen soru silindi.`, "success");
        };
    }

    function patchTaskInteractions() {
        handleDragStart = function(event, dayIdx, taskIdx) {
            taskDragState = { dayIdx, taskIdx };
            clearTaskDragVisualState();
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", `${dayIdx}:${taskIdx}`);
            }
            event.currentTarget?.classList.add("dragging");
        };

        handleDragOver = function(event) {
            event.preventDefault();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = "move";
            }
        };

        handleDrop = function(event, targetDayIdx, targetTaskIdx = null) {
            event.preventDefault();
            event.stopPropagation();
            if (!taskDragState) return;

            const weekKey = getWeekKey(currentWeekStart);
            const sourceDayIdx = clampNumber(taskDragState.dayIdx, 0, 6);
            const sourceTaskIdx = taskDragState.taskIdx;
            const sourceDay = ensureWeekDay(weekKey, sourceDayIdx);
            const targetDay = ensureWeekDay(weekKey, targetDayIdx);
            const sourceTasks = Array.isArray(sourceDay.tasks) ? sourceDay.tasks : [];
            if (!sourceTasks[sourceTaskIdx]) {
                taskDragState = null;
                clearTaskDragVisualState();
                return;
            }

            const [movedTask] = sourceTasks.splice(sourceTaskIdx, 1);
            const targetTasks = sourceDayIdx === targetDayIdx ? sourceTasks : (Array.isArray(targetDay.tasks) ? targetDay.tasks : []);
            const dropTarget = event.currentTarget?.classList.contains("task-item")
                ? event.currentTarget
                : event.target?.closest?.(".task-item");
            const dropPosition = dropTarget?.dataset.dropPosition || "before";
            let insertIndex = typeof targetTaskIdx === "number"
                ? targetTaskIdx + (dropPosition === "after" ? 1 : 0)
                : targetTasks.length;
            if (sourceDayIdx === targetDayIdx && sourceTaskIdx < insertIndex) {
                insertIndex -= 1;
            }
            insertIndex = Math.max(0, Math.min(insertIndex, targetTasks.length));
            targetTasks.splice(insertIndex, 0, movedTask);

            sourceDay.tasks = sourceTasks;
            targetDay.tasks = targetTasks;
            scheduleData[weekKey][sourceDayIdx] = syncDayQuestionState(ensureDayObject(sourceDay));
            scheduleData[weekKey][targetDayIdx] = syncDayQuestionState(ensureDayObject(targetDay));

            taskDragState = null;
            clearTaskDragVisualState();
            saveData();
            renderSchedule();
        };

        editTask = function(dayIdx, taskIdx) {
            const weekKey = getWeekKey(currentWeekStart);
            const dayData = ensureWeekDay(weekKey, dayIdx);
            const currentTask = dayData?.tasks?.[taskIdx];
            if (!currentTask) return;

            const previousLabel = String(currentTask.text || "").trim();
            const nextLabel = prompt("Görevi Düzenle:", previousLabel);
            if (nextLabel === null) return;

            const normalizedNextLabel = String(nextLabel).trim();
            if (!normalizedNextLabel) return;

            dayData.tasks[taskIdx].text = normalizedNextLabel;
            dayData.subjectQuestions = normalizeTaskQuestionMap(dayData);

            const carriedAmount = parseInteger(dayData.subjectQuestions?.[previousLabel], 0);
            if (carriedAmount > 0 && previousLabel !== normalizedNextLabel) {
                delete dayData.subjectQuestions[previousLabel];
                dayData.subjectQuestions[normalizedNextLabel] = parseInteger(dayData.subjectQuestions[normalizedNextLabel], 0) + carriedAmount;
            }

            scheduleData[weekKey][dayIdx] = syncDayQuestionState(ensureDayObject(dayData));
            saveData();
            renderSchedule();
        };

        deleteTask = function(dayIdx, taskIdx) {
            if (!confirm("Görevi silmek istiyor musun?")) return;

            const weekKey = getWeekKey(currentWeekStart);
            const dayData = ensureWeekDay(weekKey, dayIdx);
            const removedTask = dayData?.tasks?.[taskIdx];
            if (!removedTask) return;

            const removedLabel = String(removedTask.text || "").trim();
            dayData.tasks.splice(taskIdx, 1);
            dayData.subjectQuestions = normalizeTaskQuestionMap(dayData);
            delete dayData.subjectQuestions[removedLabel];
            scheduleData[weekKey][dayIdx] = syncDayQuestionState(ensureDayObject(dayData));
            saveData();
            renderSchedule();
        };
    }

    function clearLoadedUserData() {
        if (typeof currentUsername !== "undefined") currentUsername = "";
        if (typeof currentProfileAbout !== "undefined") currentProfileAbout = "";
        if (typeof currentProfileImage !== "undefined") currentProfileImage = "";
        if (typeof currentAccountCreatedAt !== "undefined") currentAccountCreatedAt = "";
        if (typeof studyTrack !== "undefined") studyTrack = "";
        if (typeof selectedSubjects !== "undefined") selectedSubjects = [];
        if (typeof profileDraftTrack !== "undefined") profileDraftTrack = "";
        if (typeof profileDraftSubjects !== "undefined") profileDraftSubjects = [];
        if (typeof onboardingSelectedSubjects !== "undefined") onboardingSelectedSubjects = [];
        if (typeof studyInsightSelectedSubjects !== "undefined") studyInsightSelectedSubjects = [];
        if (typeof currentProfileModalData !== "undefined") currentProfileModalData = null;
        if (typeof activeUserNoteId !== "undefined") activeUserNoteId = "";
        noteFolders = normalizeNoteFolders([]);
        userNotes = normalizeUserNotes([]);
        scheduleData = sanitizeScheduleData({});
        totalWorkedSecondsAllTime = 0;
        totalQuestionsAllTime = 0;
        activeNoteFolderId = NOTE_FOLDER_ALL_ID;
        lastAutoDailyResetSyncSignature = "";
    }

    function bootstrapExtendedUserData(userData = {}) {
        const rawData = userData && typeof userData === "object" ? userData : {};
        const dailyResetState = getDailySnapshotResetState(rawData);
        const safeData = dailyResetState.normalizedData;
        clearLoadedUserData();

        if (typeof currentUsername !== "undefined") {
            currentUsername = String(
                safeData.username
                || currentUser?.displayName
                || currentUser?.email?.split("@")[0]
                || safeData.email?.split?.("@")?.[0]
                || ""
            ).trim();
        }
        if (typeof currentProfileAbout !== "undefined") currentProfileAbout = String(safeData.about || "");
        if (typeof currentProfileImage !== "undefined") currentProfileImage = String(safeData.profileImage || "");
        if (typeof currentAccountCreatedAt !== "undefined") currentAccountCreatedAt = String(safeData.accountCreatedAt || "");
        if (typeof studyTrack !== "undefined") studyTrack = String(safeData.studyTrack || "");
        if (typeof selectedSubjects !== "undefined") {
            selectedSubjects = typeof normalizeSelectedSubjects === "function"
                ? normalizeSelectedSubjects(studyTrack || "", safeData.selectedSubjects || [])
                : (Array.isArray(safeData.selectedSubjects) ? [...safeData.selectedSubjects] : []);
        }
        if (typeof profileDraftTrack !== "undefined") profileDraftTrack = studyTrack || "";
        if (typeof profileDraftSubjects !== "undefined") profileDraftSubjects = Array.isArray(selectedSubjects) ? [...selectedSubjects] : [];
        if (typeof onboardingSelectedSubjects !== "undefined") onboardingSelectedSubjects = Array.isArray(selectedSubjects) ? [...selectedSubjects] : [];

        noteFolders = normalizeNoteFolders(safeData.noteFolders || []);
        userNotes = normalizeUserNotes(safeData.notes || []);
        scheduleData = sanitizeScheduleData(safeData.schedule || {});
        mergeFreshDailySnapshotIntoLocalSchedule(safeData);
        const restoredTimerRecovery = mergeTimerRecoveryScheduleIntoLocalState();
        totalWorkedSecondsAllTime = Math.max(parseInteger(safeData.totalWorkedSeconds, 0), parseInteger(safeData.totalStudyTime, 0), typeof calculateTotalWorkedSecondsFromSchedule === "function" ? calculateTotalWorkedSecondsFromSchedule(scheduleData) : 0);
        totalQuestionsAllTime = Math.max(parseInteger(safeData.totalQuestionsAllTime, 0), typeof calculateTotalQuestionsFromSchedule === "function" ? calculateTotalQuestionsFromSchedule(scheduleData) : 0);
        if (currentUser?.uid) {
            currentUserLiveDoc = {
                ...(currentUserLiveDoc || rawData || {}),
                ...safeData,
                schedule: sanitizeScheduleData(scheduleData || {})
            };
        }
        if (restoredTimerRecovery && currentUser?.uid) {
            currentUserLiveDoc = {
                ...(currentUserLiveDoc || safeData || {}),
                schedule: sanitizeScheduleData(scheduleData || {}),
                totalWorkedSeconds: Math.max(
                    parseInteger(currentUserLiveDoc?.totalWorkedSeconds, 0),
                    totalWorkedSecondsAllTime || 0
                ),
                totalStudyTime: Math.max(
                    parseInteger(currentUserLiveDoc?.totalStudyTime, 0),
                    totalWorkedSecondsAllTime || 0
                )
            };
            setTimeout(() => {
                saveData({ authorized: true, immediate: true });
            }, 0);
            safeShowAlert("Kaydedilemeyen sure geri yüklendi. Buluta tekrar gonderiliyor.", "info");
        } else if (dailyResetState.needsSync) {
            queueAutoDailyResetSync();
        }
        renderNoteFolderControls();
        restoreTimerFromPersistence(safeData);
        if (typeof updateProfileButton === "function") updateProfileButton();
        if (typeof updateMyNotesButton === "function") updateMyNotesButton();
        if (typeof updateSubjectReminder === "function") updateSubjectReminder();
        updateLiveStudyPreview();
    }

    function patchProfileCopy() {
        ensureRollingTwoDayTitleConfig();
        ensureTitleSelectionStyles();

        if (typeof renderLiveLeaderboardFromDocs === "function") {
            const originalRenderLiveLeaderboardFromDocs = renderLiveLeaderboardFromDocs;
            renderLiveLeaderboardFromDocs = function(...args) {
                const result = originalRenderLiveLeaderboardFromDocs.apply(this, args);
                refreshVisibleProfileModalFromLiveData();
                return result;
            };
        }

        if (typeof renderTitlesModal === "function") {
            renderTitlesModal = function() {
                const titlesGrid = document.getElementById("titles-grid");
                if (!titlesGrid) return;

                const titleInfo = buildResolvedTitleInfo({
                    uid: currentUser?.uid || "",
                    schedule: scheduleData || {},
                    activeTimer: timerState.session ? serializeTimerSession(timerState.session) : null,
                    selectedTitleId: getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {}),
                    titleAwards: getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {})
                });
                const currentTitleId = titleInfo.currentTitle?.id || "";
                const defaultTitleId = titleInfo.defaultTitle?.id || "";

                titlesGrid.innerHTML = ensureRollingTwoDayTitleConfig().map(level => {
                    const isUnlocked = (titleInfo.unlockedTitles || []).some(item => item.id === level.id);
                    const lifetimeText = getRemainingTitleLifetimeText(titleInfo, level.id);
                    const statusPill = level.id === currentTitleId
                        ? '<span class="profile-title-current-pill"><i class="fas fa-star"></i> Aktif</span>'
                        : (level.id === defaultTitleId
                            ? '<span class="profile-title-default-pill"><i class="fas fa-crown"></i> Varsayılan</span>'
                            : "");

                    return `
                        <div class="title-card ${isUnlocked ? "unlocked" : "locked"}">
                            <div class="title-card-header">
                                <span class="title-badge ${level.className}"><span>${level.icon}</span><span>${level.label}</span></span>
                                ${statusPill}
                            </div>
                            <p><strong>${level.requirement}</strong></p>
                            <p>${level.description}</p>
                            <div class="title-card-meta">
                                <span class="profile-title-expiry-pill"><i class="fas fa-hourglass-half"></i> ${escapeHtml(lifetimeText)}</span>
                            </div>
                        </div>
                    `;
                }).join("");
            };
        }

        if (typeof renderProfileTitles === "function") {
            renderProfileTitles = function(profileData) {
                const list = document.getElementById("profile-titles-list");
                const hint = document.getElementById("profile-titles-hint");
                const label = document.getElementById("profile-titles-label");
                if (!list || !hint || !label) return;

                const titleInfo = buildResolvedTitleInfo(profileData || {});
                const unlockedTitles = titleInfo.unlockedTitles || [];
                const currentTitleId = titleInfo.currentTitle?.id || "";
                const defaultTitleId = titleInfo.defaultTitle?.id || "";
                const manualSelectedTitleId = titleInfo.hasManualSelection ? (titleInfo.selectedTitleId || "") : "";
                const profileName = profileData?.username || "Bu kullanıcı";
                const isEditableProfile = !!currentProfileModalEditable
                    && !!currentUser?.uid
                    && String(profileData?.uid || currentUser.uid) === String(currentUser.uid);

                label.innerText = "Ünvanlar";
                hint.innerText = unlockedTitles.length
                    ? `${profileName} için açılan ${unlockedTitles.length} ünvan listeleniyor. 2 günlük ortalamaya göre açılıyor ve 7 gün aktif kalıyor.`
                    : `${profileName} henüz ünvan açmadı. Ünvanlar 2 günlük ortalamaya göre açılır ve 7 gün aktif kalır.`;

                if (!unlockedTitles.length) {
                    list.innerHTML = '<div class="profile-notes-empty">Henüz açılan ünvan bulunmuyor.</div>';
                    return;
                }

                const toolbarHtml = isEditableProfile
                    ? `
                        <div class="profile-title-toolbar">
                            <span class="profile-title-toolbar-meta">Şu an kullanılan: <strong>${escapeHtml(titleInfo.currentTitle?.label || "Yok")}</strong><span class="profile-title-toolbar-note">Varsayılan seçim en yüksek aktif ünvandır. Her ünvan 7 gün boyunca açık kalır.</span></span>
                            ${manualSelectedTitleId
                                ? '<button type="button" class="profile-title-select-btn" onclick="resetProfileTitleSelection()">Varsayılanı Kullan</button>'
                                : '<span class="profile-title-default-pill"><i class="fas fa-crown"></i> Varsayılan: En yüksek açılan ünvan</span>'}
                        </div>
                    `
                    : "";

                list.innerHTML = toolbarHtml + unlockedTitles.map(level => `
                    <article class="profile-title-card ${level.id === currentTitleId ? "current" : ""}">
                        <div class="title-inline-row">
                            <span class="title-badge ${level.className}"><span>${level.icon}</span><span>${level.label}</span></span>
                            ${level.id === currentTitleId
                                ? '<span class="profile-title-current-pill"><i class="fas fa-star"></i> Aktif Ünvan</span>'
                                : (level.id === defaultTitleId
                                    ? '<span class="profile-title-default-pill"><i class="fas fa-crown"></i> Varsayılan Ünvan</span>'
                                    : "")}
                        </div>
                        <p><strong>${level.requirement}</strong><br>${level.description}</p>
                        <div class="profile-title-expiry"><i class="fas fa-hourglass-half"></i> ${escapeHtml(getRemainingTitleLifetimeText(titleInfo, level.id))}</div>
                        ${isEditableProfile
                            ? `<button type="button" class="profile-title-select-btn ${level.id === currentTitleId ? "is-active" : ""}" ${level.id === currentTitleId ? "disabled" : `onclick="selectProfileTitle('${level.id}')"`}>${level.id === currentTitleId ? "Aktif" : "Seç"}</button>`
                            : ""}
                    </article>
                `).join("");
            };
        }

        if (typeof toggleProfileTitlesPanel === "function") {
            const originalToggleProfileTitlesPanel = toggleProfileTitlesPanel;
            toggleProfileTitlesPanel = function(...args) {
                const result = originalToggleProfileTitlesPanel.apply(this, args);
                const titlesList = document.getElementById("profile-titles-list");
                const toggleBtn = document.getElementById("profile-titles-toggle-btn");
                if (toggleBtn) {
                    const expanded = !(titlesList?.classList.contains("is-collapsed"));
                    toggleBtn.innerHTML = expanded
                        ? '<i class="fas fa-chevron-up"></i> Ünvanları Gizle'
                        : '<i class="fas fa-chevron-down"></i> Ünvanları Göster';
                }
                return result;
            };
        }

        if (typeof showProfileModal === "function") {
            const originalShowProfileModal = showProfileModal;
            showProfileModal = function(profileData = {}, editable = false) {
                const resolvedProfile = buildProfileModalPayload({
                    uid: profileData?.uid || "",
                    baseProfile: profileData || {},
                    userProfile: editable ? (currentUserLiveDoc || {}) : {},
                    cachedProfile: !editable && profileData?.uid ? (leaderboardUserProfiles[profileData.uid] || {}) : {},
                    editable: !!editable
                });
                const result = originalShowProfileModal.call(this, resolvedProfile, editable);
                const syncedProfile = applyProfileStatsToModal(resolvedProfile);
                const titleWrapper = document.getElementById("profile-title-wrapper");
                if (titleWrapper) {
                    titleWrapper.innerHTML = titleWrapper.innerHTML
                        .replace(/Haftalik gunluk ortalama/gi, "2 günlük ortalama")
                        .replace(/Haftalık günlük ortalama/gi, "2 günlük ortalama")
                        .replace(/Aktif Unvan/gi, "Aktif Ünvan");
                }
                const titlesLabel = document.getElementById("profile-titles-label");
                if (titlesLabel) titlesLabel.innerText = "Ünvanlar";
                if (typeof currentProfileModalData !== "undefined") {
                    currentProfileModalData = {
                        ...(currentProfileModalData || {}),
                        ...syncedProfile,
                        notes: resolvedProfile.notes
                    };
                }
                return result;
            };
        }

        openProfileModal = function() {
            refreshCurrentTotals();
            const resolvedProfile = buildProfileModalPayload({
                uid: currentUser?.uid || "",
                editable: true,
                userProfile: currentUserLiveDoc || {},
                baseProfile: {
                    username: currentUsername,
                    email: currentUser?.email || "",
                    isAdmin: typeof isCurrentAdmin === "function" ? isCurrentAdmin() : false,
                    about: currentProfileAbout,
                    profileImage: currentProfileImage,
                    totalWorkedSeconds: totalWorkedSecondsAllTime,
                    totalStudyTime: totalWorkedSecondsAllTime,
                    totalQuestionsAllTime: totalQuestionsAllTime,
                    accountCreatedAt: currentAccountCreatedAt,
                    studyTrack: studyTrack,
                    selectedSubjects: selectedSubjects,
                    notes: normalizeUserNotes(userNotes),
                    schedule: scheduleData,
                    selectedTitleId: getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {}),
                    titleAwards: getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {})
                }
            });
            showProfileModal(resolvedProfile, true);
        };

        openLeaderboardProfile = async function(uid) {
            if (currentUser && currentUser.uid === uid) {
                openProfileModal();
                return;
            }

            const cachedProfile = leaderboardUserProfiles[uid];
            if (!cachedProfile && !uid) return;

            try {
                const [userDoc, profileDoc] = await Promise.all([
                    db.collection("users").doc(uid).get().catch(() => null),
                    db.collection(PUBLIC_PROFILE_COLLECTION).doc(uid).get().catch(() => null)
                ]);
                const userData = userDoc?.exists ? (userDoc.data() || {}) : {};
                const publicData = profileDoc?.exists ? (profileDoc.data() || {}) : {};
                const hasRemoteData = !!(userDoc?.exists || profileDoc?.exists);

                if (!hasRemoteData && !cachedProfile) return;

                const resolvedProfile = buildProfileModalPayload({
                    uid,
                    userProfile: userData,
                    publicProfile: publicData,
                    cachedProfile: cachedProfile || {},
                    editable: false
                });

                leaderboardUserProfiles[uid] = {
                    ...(cachedProfile || {}),
                    ...resolvedProfile
                };
                showProfileModal(resolvedProfile, false);
            } catch (error) {
                console.error("Profil verisi yuklenirken hata:", error);
                if (cachedProfile) {
                    showProfileModal(buildProfileModalPayload({
                        uid,
                        cachedProfile,
                        editable: false
                    }), false);
                    return;
                }
                safeShowAlert("Profil yuklenemedi.");
            }
        };
    }

    function patchAuthFlows() {
        signInWithEmailPassword = function() {
            const email = document.getElementById("login-email")?.value.trim() || "";
            const password = document.getElementById("login-password")?.value || "";
            const submitButton = document.querySelector("#login-form button");

            if (!email) return setAuthErrorMessage("E-posta adresini yaz.");
            if (!password) return setAuthErrorMessage("Şifreni yaz.");

            setAuthErrorMessage("");
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Giriş Yapılıyor';
            }

            auth.signInWithEmailAndPassword(email, password)
                .then(async credential => {
                    localStorage.setItem(VERIFY_EMAIL_KEY, email);
                    await credential.user.reload();
                    await updateEmailVerificationField(credential.user);
                    const userDoc = await db.collection("users").doc(credential.user.uid).get().catch(() => null);
                    const userData = userDoc?.exists ? (userDoc.data() || {}) : {};
                    requiresEmailVerification = !!userData.requiresEmailVerification;

                    if (requiresEmailVerification && !credential.user.emailVerified) {
                        showVerificationGate({
                            email,
                            meta: "Bu yeni hesap için email doğrulaması tamamlanmadan uygulama açılamaz."
                        });
                        setAuthErrorMessage("");
                        return;
                    }

                    requiresEmailVerification = false;
                    hideVerificationGate();
                })
                .catch(error => {
                    console.error("Firebase login error:", error?.code || "", error?.message || "", error);
                    setAuthErrorMessage(translateExtendedAuthError(error, "login"));
                })
                .finally(() => {
                    if (submitButton) {
                        submitButton.disabled = false;
                        submitButton.innerHTML = '<i class="fas fa-sign-in-alt"></i> GİRİŞ YAP';
                    }
                });
        };

        signUpWithEmailPasswordAndUsername = function() {
            const username = document.getElementById("signup-username")?.value.trim() || "";
            const email = document.getElementById("signup-email")?.value.trim() || "";
            const password = document.getElementById("signup-password")?.value || "";
            const submitButton = document.querySelector("#signup-form button");

            if (username.length < 2) return setAuthErrorMessage("Kullanıcı adı en az 2 karakter olmalı.");
            if (!email) return setAuthErrorMessage("E-posta adresini yaz.");
            if (password.length < 6) return setAuthErrorMessage("Şifre en az 6 karakter olmalı.");

            setAuthErrorMessage("");
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Kayıt Oluşturuluyor';
            }

            const accountCreatedAt = new Date().toISOString();

            auth.createUserWithEmailAndPassword(email, password)
                .then(async credential => {
                    const signupPayload = createSignupPayload(username, email, accountCreatedAt);
                    await db.collection("users").doc(credential.user.uid).set(signupPayload, { merge: true });
                    currentUser = credential.user;
                    currentUsername = username;
                    currentAccountCreatedAt = accountCreatedAt;
                    await db.collection(PUBLIC_PROFILE_COLLECTION).doc(credential.user.uid).set({
                        ...buildPublicProfilePayload(signupPayload),
                        uid: credential.user.uid
                    }, { merge: true });
                    await credential.user.sendEmailVerification();
                    localStorage.setItem(VERIFY_EMAIL_KEY, email);
                    localStorage.setItem(VERIFY_COOLDOWN_KEY, String(Date.now() + VERIFY_COOLDOWN_MS));
                    showVerificationGate({
                        email,
                        success: true,
                        meta: "Doğrulama maili gönderildi."
                    });
                    await updateEmailVerificationField(credential.user, { forceGate: true });
                    safeShowAlert(VERIFY_MESSAGE, "success");
                })
                .catch(error => {
                    console.error("Firebase signup error:", error?.code || "", error?.message || "", error);
                    setAuthErrorMessage(translateExtendedAuthError(error, "signup"));
                })
                .finally(() => {
                    if (submitButton) {
                        submitButton.disabled = false;
                        submitButton.innerHTML = '<i class="fas fa-user-plus"></i> KAYIT OL';
                    }
                    refreshVerificationCooldownUI();
                });
        };

        sendPasswordResetLink = function() {
            const email = document.getElementById("login-email")?.value.trim() || "";
            if (!email) return setAuthErrorMessage("Şifre sıfırlamak için önce e-posta adresini yaz.");

            setAuthErrorMessage("");
            auth.sendPasswordResetEmail(email)
                .then(() => {
                    setAuthErrorMessage(RESET_PASSWORD_MESSAGE);
                    safeShowAlert(RESET_PASSWORD_MESSAGE, "success");
                })
                .catch(error => {
                    setAuthErrorMessage(translateExtendedAuthError(error, "reset"));
                });
        };
    }

    function patchQuestionTracking() {
        updateQuestions = function(dayIdx) {
            const input = document.getElementById(`q-input-${dayIdx}`);
            const select = document.getElementById(`q-subject-${dayIdx}`);
            if (!input) return;

            const rawValue = parseInteger(input.value, 0);
            if (rawValue > QUESTION_LIMIT) {
                input.value = String(QUESTION_LIMIT);
                setQuestionValidation(dayIdx, getQuestionLimitError());
                safeShowAlert(getQuestionLimitError());
                return;
            }

            const value = clampNumber(rawValue, 0, QUESTION_LIMIT);
            if (value <= 0) {
                input.value = "";
                setQuestionValidation(dayIdx, "");
                return;
            }

            const weekKey = getWeekKey(currentWeekStart);
            const dayData = syncDayQuestionState(ensureWeekDay(weekKey, dayIdx));
            const taskLabel = getSafeSelectedTask(dayData, select?.value || "");
            if (!taskLabel) {
                setQuestionValidation(dayIdx, "Önce görev eklemelisiniz");
                safeShowAlert("Önce görev ekleyin, sonra soru girin.");
                return;
            }

            const otherQuestionsTotal = Object.entries(dayData.subjectQuestions || {})
                .filter(([key]) => key !== taskLabel)
                .reduce((sum, [, amount]) => sum + parseInteger(amount, 0), 0);

            if ((otherQuestionsTotal + value) > QUESTION_LIMIT) {
                setQuestionValidation(dayIdx, getQuestionLimitError());
                safeShowAlert(getQuestionLimitError());
                return;
            }

            dayData.subjectQuestions = normalizeTaskQuestionMap(dayData);
            dayData.subjectQuestions[taskLabel] = value;
            dayData.questions = Object.values(dayData.subjectQuestions || {}).reduce((sum, amount) => sum + parseInteger(amount, 0), 0);
            scheduleData[weekKey][dayIdx] = ensureDayObject(dayData);
            totalQuestionsAllTime = typeof calculateTotalQuestionsFromSchedule === "function"
                ? calculateTotalQuestionsFromSchedule(scheduleData)
                : totalQuestionsAllTime;

            saveData({ authorized: true, immediate: true });
            syncPublicProfileSnapshotSafely(typeof buildUserPayload === "function" ? buildUserPayload() : null);
            syncLeaderboardSnapshotSafely(typeof buildUserPayload === "function" ? buildUserPayload() : null);
            syncPublicQuestionCountersNow();
            maybeAutoSyncLeaderboardCollection({ force: true });
            syncQuestionCountersAfterInput(dayIdx, dayData.questions);
            refreshLeaderboardOptimistically();
            input.value = "";
            setQuestionValidation(dayIdx, "");
            renderSchedule();
            safeShowAlert(`${getQuestionTrackingLabel(taskLabel)} için soru sayısı ${value} olarak kaydedildi.`, "success");
        };

        clearQuestions = function(dayIdx) {
            const weekKey = getWeekKey(currentWeekStart);
            const dayData = syncDayQuestionState(ensureWeekDay(weekKey, dayIdx));
            const select = document.getElementById(`q-subject-${dayIdx}`);
            const taskLabel = getSafeSelectedTask(dayData, select?.value || "");
            dayData.subjectQuestions = normalizeTaskQuestionMap(dayData);

            if (taskLabel && dayData.subjectQuestions[taskLabel]) {
                delete dayData.subjectQuestions[taskLabel];
            } else {
                dayData.subjectQuestions = {};
            }

            dayData.questions = Object.values(dayData.subjectQuestions || {}).reduce((sum, amount) => sum + parseInteger(amount, 0), 0);
            scheduleData[weekKey][dayIdx] = ensureDayObject(dayData);
            totalQuestionsAllTime = typeof calculateTotalQuestionsFromSchedule === "function"
                ? calculateTotalQuestionsFromSchedule(scheduleData)
                : totalQuestionsAllTime;
            saveData({ authorized: true, immediate: true });
            syncPublicProfileSnapshotSafely(typeof buildUserPayload === "function" ? buildUserPayload() : null);
            syncLeaderboardSnapshotSafely(typeof buildUserPayload === "function" ? buildUserPayload() : null);
            syncPublicQuestionCountersNow();
            maybeAutoSyncLeaderboardCollection({ force: true });
            syncQuestionCountersAfterInput(dayIdx, dayData.questions);
            refreshLeaderboardOptimistically();
            renderSchedule();
        };
    }

    function installStrictFirestoreSafetyLayer() {
        if (installStrictFirestoreSafetyLayer.installed) return;
        installStrictFirestoreSafetyLayer.installed = true;

        flushScheduledCurrentUserSave = function(options = {}) {
            if (currentUserSaveTimer) {
                clearTimeout(currentUserSaveTimer);
                currentUserSaveTimer = null;
            }

            const label = options.label || "saveData";
            const shouldNotify = options.notify || currentUserSaveNoticePending;
            currentUserSaveNoticePending = false;
            const resolvers = [...currentUserSaveResolvers];
            currentUserSaveResolvers = [];
            const isAuthorized = options.authorized === true || currentUserSaveAuthorized;
            currentUserSaveAuthorized = false;

            if (!currentUser) {
                resolvers.forEach(resolve => resolve());
                return Promise.resolve();
            }

            if (!isAuthorized && !ensureManualWriteAllowed(label)) {
                resolvers.forEach(resolve => resolve());
                return Promise.resolve();
            }

            const writePromise = withManualFirestoreWrite(() => queueCurrentUserWrite(label, async () => {
                const payload = typeof buildUserPayload === "function" ? buildUserPayload() : {};
                const userRef = db.collection("users").doc(currentUser.uid);
                await userRef.set(payload, { merge: true });
                await syncPublicProfileSnapshot(payload);
                await syncLeaderboardSnapshot(payload);
                clearTimerRecoverySnapshot(currentUser.uid);
                if (shouldNotify) {
                    safeShowAlert("Veriler buluta kaydedildi.", "success");
                }
            }));

            writePromise.finally(() => {
                resolvers.forEach(resolve => resolve());
            });

            return writePromise;
        };

        scheduleCurrentUserSave = function(options = {}) {
            if (!currentUser) return Promise.resolve();
            const isAuthorized = options.authorized === true || hasManualWriteIntent();
            if (!isAuthorized) {
                console.warn(`${options.label || "saveData"} otomatik yazma korumasi nedeniyle planlanmadi.`);
                return Promise.resolve();
            }

            if (options.notify) {
                currentUserSaveNoticePending = true;
            }

            currentUserSaveAuthorized = currentUserSaveAuthorized || isAuthorized;

            return new Promise(resolve => {
                currentUserSaveResolvers.push(resolve);
                if (currentUserSaveTimer) {
                    clearTimeout(currentUserSaveTimer);
                }

                currentUserSaveTimer = setTimeout(() => {
                    flushScheduledCurrentUserSave({
                        notify: options.notify,
                        label: options.label || "saveData",
                        authorized: currentUserSaveAuthorized
                    }).catch(() => null);
                }, options.immediate ? 0 : USER_SAVE_DEBOUNCE_MS);
            });
        };

        updateEmailVerificationField = function(user, options = {}) {
            if (!user) return Promise.resolve();
            const patch = {
                email: user.email || "",
                emailVerified: !!user.emailVerified
            };

            if (user.emailVerified) {
                patch.requiresEmailVerification = false;
            } else if (options.forceGate) {
                patch.requiresEmailVerification = true;
            }

            const isAuthorized = options.authorized === true || hasManualWriteIntent();
            if (!isAuthorized) return Promise.resolve();

            return withManualFirestoreWrite(() => db.collection("users").doc(user.uid).get().then(doc => {
                if (!doc.exists) return;
                return db.collection("users").doc(user.uid).update(patch);
            }).catch(error => {
                console.error("Email dogrulama alani yazilamadi:", error);
            }));
        };

        syncRealtimeTimer = async function(reason = "manual", options = {}) {
            const liveSyncSession = options.clearActive
                ? null
                : (options.activeSession === undefined ? timerState.session : options.activeSession);
            if (liveSyncSession?.isRunning) {
                const liveDelta = applyPendingTimerDelta(liveSyncSession);
                if (liveDelta > 0) {
                    const liveElapsedSeconds = getTimerElapsedSeconds(liveSyncSession);
                    liveSyncSession.lastPersistedElapsedSeconds = Math.max(
                        parseInteger(liveSyncSession.lastPersistedElapsedSeconds, 0),
                        liveElapsedSeconds
                    );

                    if (timerState.session && (options.activeSession === undefined || liveSyncSession === timerState.session)) {
                        timerState.session.lastPersistedElapsedSeconds = Math.max(
                            parseInteger(timerState.session.lastPersistedElapsedSeconds, 0),
                            liveElapsedSeconds
                        );
                        timerDrafts[timerState.session.mode] = { ...timerState.session };
                    }
                }
            }

            const commitSourceSession = options.commitSourceSession || timerState.session;
            if (options.commitElapsed === true && commitSourceSession) {
                const delta = applyPendingTimerDelta(commitSourceSession);
                if (delta > 0) {
                    persistTimerRecoverySnapshot();
                    const committedElapsedSeconds = Math.max(
                        parseInteger(options.committedElapsedSeconds, 0),
                        getTimerElapsedSeconds(commitSourceSession)
                    );
                    if (timerState.session) {
                        timerState.session.lastPersistedElapsedSeconds = Math.max(
                            parseInteger(timerState.session.lastPersistedElapsedSeconds, 0),
                            committedElapsedSeconds
                        );
                        timerDrafts[timerState.session.mode] = { ...timerState.session };
                    }
                }
            }

            const activeSession = options.clearActive ? null : (options.activeSession === undefined ? timerState.session : options.activeSession);
            persistTimerSessionLocally(activeSession);
            updateLocalActiveTimerSnapshot(activeSession);

            if (options.userTriggeredWrite && currentUser && ((options.authorized === true) || ensureManualWriteAllowed(`timer:${reason}`))) {
                try {
                    await withManualFirestoreWrite(() => queueCurrentUserWrite(`timer:${reason}`, async () => {
                        const payload = buildRealtimeStudyPayload({
                            activeSession,
                            currentSessionTime: options.currentSessionTime
                        });
                        const mergedPayload = {
                            ...(currentUserLiveDoc || {}),
                            ...payload
                        };
                        currentUserLiveDoc = mergedPayload;

                        if (isPresenceOnlyTimerSyncReason(reason)) {
                            await syncRealtimeLeaderboardPresence(mergedPayload);
                        } else {
                            const userRef = db.collection("users").doc(currentUser.uid);
                            await userRef.set(payload, { merge: true });
                            await syncLeaderboardSnapshot({
                                ...(typeof buildUserPayload === "function" ? buildUserPayload() : {}),
                                ...mergedPayload
                            });
                        }
                        clearTimerRecoverySnapshot(currentUser.uid);
                    }));
                } catch (error) {
                    persistTimerRecoverySnapshot();
                    console.error("Gercek zamanli sure senkronu basarisiz:", error);
                    throw error;
                }
            }

            if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
                renderLiveLeaderboardFromDocs();
            }

            renderSchedule();
        };

        startOrResumeRealtimeTimer = async function() {
            if (guardVerifiedAccess()) return;

            const mode = timerState.mode;
            let session = timerState.session;

            if (!session || session.mode !== mode) {
                session = createEmptyTimerSession(mode);
            }

            if (mode === "pomodoro") {
                const totalSeconds = getPomodoroInputSeconds();
                if (totalSeconds <= 0) {
                    safeShowAlert("Pomodoro suresi 0 olamaz.");
                    return;
                }
                if (!session.baseElapsedSeconds && !session.lastPersistedElapsedSeconds) {
                    session.targetDurationSeconds = totalSeconds;
                } else {
                    session.targetDurationSeconds = Math.max(totalSeconds, session.baseElapsedSeconds || totalSeconds);
                }
            } else {
                session.targetDurationSeconds = 0;
            }

            session.mode = mode;
            session.isRunning = true;
            session.startedAtMs = Date.now();
            session.modalOpen = isTimerModalOpen();
            session.lastSeenAtMs = Date.now();

            timerState.session = session;
            timerDrafts[mode] = { ...session };
            isRunning = true;
            persistTimerSessionLocally(session);

            startTimerLoops();
            renderTimerUi();
            refreshLeaderboardOptimistically();
            monitorTimerSyncPromise(syncRealtimeTimer("start", {
                activeSession: session,
                currentSessionTime: getTimerElapsedSeconds(session),
                userTriggeredWrite: true,
                authorized: true
            }), {
                label: "timer-start",
                failureMessage: "Canli senkron gecikti. Sure cihazda korunuyor."
            });
        };

        pauseRealtimeTimer = async function(options = {}) {
            if (!timerState.session) return true;

            const session = timerState.session;
            const commitSourceSession = createCommitSourceSession(session);
            const elapsed = getTimerElapsedSeconds(commitSourceSession);
            session.baseElapsedSeconds = elapsed;
            session.isRunning = false;
            session.startedAtMs = 0;
            session.modalOpen = false;
            timerState.session = session;
            timerDrafts[session.mode] = { ...session };
            isRunning = false;
            stopTimerLoops();
            refreshLeaderboardOptimistically(null);
            renderTimerUi();
            monitorTimerSyncPromise(syncRealtimeTimer("pause", {
                activeSession: null,
                currentSessionTime: 0,
                clearActive: true,
                commitElapsed: true,
                commitSourceSession,
                committedElapsedSeconds: elapsed,
                userTriggeredWrite: true,
                authorized: true
            }), {
                label: "timer-pause",
                timeoutMessage: options.silentWriteFailure ? "" : "Duraklatma alindi. Bulut senkronu arkada suruyor.",
                failureMessage: options.silentWriteFailure ? "" : "Sure cihazda korundu. Baglanti duzelince tekrar kaydetmeyi dene."
            });
            return true;
        };

        completePomodoroSession = async function() {
            if (!timerState.session) return;

            const session = timerState.session;
            const commitSourceSession = createCommitSourceSession(session);
            const elapsed = Math.max(parseInteger(session.targetDurationSeconds, 0), getTimerElapsedSeconds(commitSourceSession));
            session.baseElapsedSeconds = elapsed;
            session.isRunning = false;
            session.startedAtMs = 0;
            stopTimerLoops();
            isRunning = false;
            releaseTimerOwnership();
            timerState.session = session;
            timerDrafts.pomodoro = { ...session };
            persistTimerSessionLocally(session);
            refreshLeaderboardOptimistically(null);
            renderTimerUi();
            monitorTimerSyncPromise(syncRealtimeTimer("complete", {
                activeSession: session,
                currentSessionTime: 0,
                commitElapsed: true,
                commitSourceSession,
                committedElapsedSeconds: elapsed,
                userTriggeredWrite: true,
                authorized: true
            }), {
                label: "timer-complete",
                failureMessage: "Pomodoro tamamlandi. Sure cihazda korundu ve tekrar gonderilecek."
            });
            safeShowAlert("Pomodoro oturumu tamamlandi ve sure kaydedildi.", "success");
        };

        resetRealtimeTimer = async function(resetInputs = true, silent = false) {
            stopTimerLoops();
            isRunning = false;
            timerState.session = null;
            persistTimerSessionLocally(null);
            releaseTimerOwnership();

            if (resetInputs && timerState.mode === "pomodoro") {
                const hours = document.getElementById("study-hours");
                const minutes = document.getElementById("study-minutes");
                const seconds = document.getElementById("study-seconds");
                if (hours) hours.value = 0;
                if (minutes) minutes.value = 0;
                if (seconds) seconds.value = 0;
            }

            timerState.session = createEmptyTimerSession(timerState.mode);
            if (timerState.mode === "pomodoro") {
                timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
            }
            timerDrafts[timerState.mode] = { ...timerState.session };

            refreshLeaderboardOptimistically(null);
            renderTimerUi();
            monitorTimerSyncPromise(syncRealtimeTimer("reset", {
                activeSession: null,
                currentSessionTime: 0,
                clearActive: true,
                userTriggeredWrite: true,
                authorized: true
            }), {
                label: "timer-reset",
                timeoutMessage: "Sifirlama cihazda tamamlandi. Bulut guncellemesi arkada suruyor.",
                failureMessage: "Sifirlama cihazda tamamlandi. Bulut baglantisi gelince tekrar esitlecek."
            });
            if (!silent) {
                safeShowAlert("Zamanlayici sifirlandi.");
            }
        };

        const originalUpdateTimerSessionPill = updateTimerSessionPill;
        updateTimerSessionPill = function() {
            if (typeof originalUpdateTimerSessionPill === "function") {
                originalUpdateTimerSessionPill();
            }

            const pill = document.getElementById("timer-session-pill");
            if (!pill) return;
            const unsaved = timerState.session ? Math.max(0, getTimerElapsedSeconds(timerState.session) - parseInteger(timerState.session.lastPersistedElapsedSeconds, 0)) : 0;
            const modeLabel = timerState.mode === "stopwatch" ? "Kronometre" : "Pomodoro";
            pill.innerHTML = `<i class="fas fa-wave-square"></i> ${modeLabel} - Otomatik kayit acik${unsaved > 0 ? ` - ${unsaved}s bekleyen senkron` : ""}`;
        };

        const originalPatchTimerControls = patchTimerControls;
        patchTimerControls = function() {
            if (typeof originalPatchTimerControls === "function") {
                originalPatchTimerControls();
            }

            hidePomodoroModal = (function(originalHidePomodoroModal) {
                return function() {
                    const finalizeHide = () => {
                        if (typeof originalHidePomodoroModal === "function") {
                            originalHidePomodoroModal();
                        } else {
                            document.getElementById("pomodoro-modal").style.display = "none";
                        }
                        if (typeof syncBodyModalLock === "function") syncBodyModalLock();
                    };

                    finalizeHide();
                };
            })(typeof hidePomodoroModal === "function" ? hidePomodoroModal : null);
        };

        attachRealtimeListeners = function() {
            auth.onAuthStateChanged(async user => {
                ensureVerificationCard();
                applyTurkishInputSupport();

                if (!user) {
                    const hadSession = !!timerState.session;
                    if (hadSession) {
                        preserveTimerStateForRecovery(timerState.session, {
                            modalOpen: false,
                            includeRecovery: true
                        });
                    }

                    currentUser = null;
                    currentUserLiveDoc = null;
                    currentUserWriteChain = Promise.resolve();
                    requiresEmailVerification = false;
                    hasBootstrappedUsersRealtime = false;
                    noteFolders = normalizeNoteFolders([]);
                    activeNoteFolderId = NOTE_FOLDER_ALL_ID;
                    unsubscribeRealtimeLeaderboard();
                    if (currentUserSaveTimer) {
                        clearTimeout(currentUserSaveTimer);
                        currentUserSaveTimer = null;
                    }
                    currentUserSaveNoticePending = false;
                    currentUserSaveAuthorized = false;
                    currentUserSaveResolvers = [];
                    stopTimerLoops();
                    timerState.session = null;
                    if (!hadSession) {
                        persistTimerSessionLocally(null);
                    }
                    releaseTimerOwnership();
                    clearLegacyPomodoroStorage();
                    hideVerificationGate();
                    renderTimerUi();
                    return;
                }

                currentUser = user;
                localStorage.setItem(VERIFY_EMAIL_KEY, user.email || "");

                try {
                    await user.reload();
                } catch (error) {
                    console.error("Kullanici yenilenemedi:", error);
                }

                hideVerificationGate();
                hasBootstrappedUsersRealtime = false;
                subscribeRealtimeLeaderboard();
            });

            window.addEventListener("beforeunload", () => {
                if (timerState.session) {
                    preserveTimerStateForRecovery(timerState.session, {
                        modalOpen: isTimerModalOpen(),
                        includeRecovery: getPendingTimerDelta(timerState.session) > 0
                    });
                } else {
                    localStorage.removeItem(TIMER_STORAGE_KEY);
                }
                clearLegacyPomodoroStorage();
                releaseTimerOwnership();
            });
        };
    }

    function patchTimerControls() {
        toggleTimer = async function() {
            if (timerState.transitioning) return;
            timerState.transitioning = true;

            try {
                if (timerState.session?.isRunning) {
                    await pauseRealtimeTimer();
                } else {
                    await startOrResumeRealtimeTimer();
                }
            } catch (error) {
                console.error("Zamanlayici baslatilamadi:", error);
                safeShowAlert("Zamanlayici baslatilirken bir hata olustu.");
            } finally {
                timerState.transitioning = false;
            }
        };

        updateTimerFromInputsAndReset = function() {
            if (timerState.session?.isRunning) return;

            if (timerState.mode === "pomodoro") {
                const totalSeconds = getPomodoroInputSeconds();
                timerState.session = createEmptyTimerSession("pomodoro");
                timerState.session.targetDurationSeconds = totalSeconds;
            } else {
                timerState.session = createEmptyTimerSession("stopwatch");
            }

            renderTimerUi();
        };

        resetTimer = async function(_stop, resetInputs) {
            if (timerState.transitioning) return;
            timerState.transitioning = true;

            try {
                await resetRealtimeTimer(resetInputs !== false);
            } finally {
                timerState.transitioning = false;
            }
        };

        saveWorkSession = function() {
            const finishAndClose = async () => {
                if (timerState.transitioning) return;
                timerState.transitioning = true;

                try {
                    const activeSession = timerState.session ? { ...timerState.session } : null;
                    const commitSourceSession = activeSession ? createCommitSourceSession(activeSession) : null;
                    const committedElapsedSeconds = commitSourceSession
                        ? getTimerElapsedSeconds(commitSourceSession)
                        : 0;

                    if (activeSession) {
                        activeSession.baseElapsedSeconds = committedElapsedSeconds;
                        activeSession.isRunning = false;
                        activeSession.startedAtMs = 0;
                        activeSession.modalOpen = false;
                        timerDrafts[activeSession.mode] = { ...activeSession };
                        isRunning = false;
                        stopTimerLoops();
                    }

                    const syncPromise = withManualFirestoreWrite(() => syncRealtimeTimer("manual-save", {
                        activeSession: null,
                        currentSessionTime: 0,
                        clearActive: true,
                        commitElapsed: !!commitSourceSession,
                        commitSourceSession,
                        committedElapsedSeconds,
                        userTriggeredWrite: true,
                        authorized: true
                    }));

                    timerState.session = null;
                    persistTimerSessionLocally(null);
                    releaseTimerOwnership();
                    refreshLeaderboardOptimistically(null);
                    renderTimerUi();
                    hidePomodoroModal();
                    safeShowAlert("Süre durduruldu. Senkron arka planda tamamlanıyor.", "success");
                    monitorTimerSyncPromise(syncPromise, {
                        label: "timer-save",
                        timeoutMessage: "Kayit alindi. Bulut senkronu arkada suruyor.",
                        failureMessage: "Sure cihazda korundu. Baglanti gelince tekrar kaydetmeyi dene."
                    });
                } finally {
                    timerState.transitioning = false;
                }
            };

            finishAndClose().catch(error => {
                console.error("Sure kaydedilip durdurulamadi:", error);
                safeShowAlert("Süre kaydedilirken bir hata oluştu.");
            });
        };

        checkActiveTimer = function() {
            renderTimerUi();
        };

        showPomodoroModal = (function(originalShowPomodoroModal) {
            return function() {
                if (guardVerifiedAccess()) return;
                touchTimerVisibility(Date.now(), { modalOpen: true, persist: !!timerState.session });
                if (typeof originalShowPomodoroModal === "function") {
                    originalShowPomodoroModal();
                } else {
                    document.getElementById("pomodoro-modal").style.display = "flex";
                }
                ensureTimerModeUi();
                setTimerMode(timerState.mode, { persist: false, keepSession: true });
                if (timerState.session?.isRunning) {
                    syncRealtimeTimer("modal-show", {
                        activeSession: timerState.session,
                        currentSessionTime: getTimerElapsedSeconds(timerState.session),
                        userTriggeredWrite: true,
                        authorized: true
                    }).catch(error => {
                        console.error("Timer modal acilis senkronu basarisiz:", error);
                    });
                }
                renderTimerUi();
                if (typeof syncBodyModalLock === "function") syncBodyModalLock();
            };
        })(typeof showPomodoroModal === "function" ? showPomodoroModal : null);

        hidePomodoroModal = (function(originalHidePomodoroModal) {
            return function() {
                if (timerState.session?.isRunning) {
                    touchTimerVisibility(Date.now(), { modalOpen: false, persist: true });
                    syncRealtimeTimer("modal-hide", {
                        activeSession: timerState.session,
                        currentSessionTime: getTimerElapsedSeconds(timerState.session),
                        userTriggeredWrite: true,
                        authorized: true
                    }).catch(error => {
                        console.error("Timer modal kapanis senkronu basarisiz:", error);
                    });
                } else {
                    syncRealtimeTimer("modal-hide");
                }
                if (typeof originalHidePomodoroModal === "function") {
                    originalHidePomodoroModal();
                } else {
                    document.getElementById("pomodoro-modal").style.display = "none";
                }
                if (typeof syncBodyModalLock === "function") syncBodyModalLock();
            };
        })(typeof hidePomodoroModal === "function" ? hidePomodoroModal : null);

        updateTimerDisplay = function() {
            renderTimerUi();
        };
    }

    function patchLeaderboardRealtime() {
        toggleLeaderboard = function() {
            if (guardVerifiedAccess()) return;
            const panel = document.getElementById("leaderboard-panel");
            if (!panel) return;

            const isOpen = panel.classList.contains("open");
            if (isOpen) {
                panel.classList.remove("open");
                return;
            }

            panel.classList.add("open");
            subscribeRealtimeLeaderboard();
            renderLiveLeaderboardFromDocs();
        };

        switchLeaderboardTab = function(tab) {
            currentLeaderboardTab = tab === "weekly" ? "weekly" : "daily";
            document.getElementById("tab-daily")?.classList.toggle("active", currentLeaderboardTab === "daily");
            document.getElementById("tab-weekly")?.classList.toggle("active", currentLeaderboardTab === "weekly");
            renderLiveLeaderboardFromDocs();
        };

        fetchAndRenderLeaderboard = function() {
            subscribeRealtimeLeaderboard();
            renderLiveLeaderboardFromDocs();
        };
    }

    function patchNotesFolders() {
        normalizeUserNotes = function(notes) {
            if (!Array.isArray(notes)) return [];

            return notes.map((note, index) => {
                const title = String(note && note.title ? note.title : "").trim();
                const content = String(note && note.content ? note.content : "").trim();
                if (!title && !content) return null;
                const createdAt = note && note.createdAt ? note.createdAt : new Date().toISOString();
                return {
                    id: note && note.id ? String(note.id) : `note_${Date.now().toString(36)}_${index}`,
                    title: title || "Başlıksız Not",
                    content,
                    folderId: note && note.folderId ? String(note.folderId) : NOTE_FOLDER_DEFAULT_ID,
                    isPublic: !!(note && note.isPublic),
                    createdAt,
                    updatedAt: note && note.updatedAt ? note.updatedAt : createdAt
                };
            }).filter(Boolean);
        };

        renderMyNotesPanel = function() {
            ensureNotesFolderUi();
            const normalizedNotes = normalizeUserNotes(userNotes || []);
            userNotes = normalizedNotes;
            renderNoteFolderControls();

            const filteredNotes = filterNotesByActiveFolder(normalizedNotes);
            const list = document.getElementById("my-notes-list");
            const totalCount = normalizedNotes.length;
            const publicCount = normalizedNotes.filter(note => note.isPublic).length;

            document.getElementById("my-notes-total-count").textContent = `${totalCount} not`;
            document.getElementById("my-notes-public-count").textContent = `${publicCount} herkese açık`;
            if (typeof updateMyNotesButton === "function") {
                updateMyNotesButton();
            }

            if (!list) return;

            if (activeUserNoteId && !normalizedNotes.some(note => note.id === activeUserNoteId)) {
                resetMyNoteEditor();
            }

            if (!filteredNotes.length) {
                list.innerHTML = `<div class="notes-empty notes-list-empty-folder">${activeNoteFolderId === NOTE_FOLDER_ALL_ID ? "Henüz not eklemedin." : `"${escapeHtml(getFolderName(activeNoteFolderId))}" klasöründe not yok.`}</div>`;
                return;
            }

            list.innerHTML = filteredNotes.map((note, index) => `
                <article class="user-note-card ${note.isPublic ? "public" : "private"}">
                    <div class="note-card-top">
                        <div class="note-card-title">${escapeHtml(note.title)}</div>
                        <div style="display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end;">
                            <span class="note-folder-badge"><i class="fas fa-folder"></i> ${escapeHtml(getFolderName(note.folderId || NOTE_FOLDER_DEFAULT_ID))}</span>
                            <span class="note-visibility-pill ${note.isPublic ? "public" : "private"}">
                                <i class="fas ${note.isPublic ? "fa-earth-europe" : "fa-lock"}"></i>
                                ${note.isPublic ? "Public" : "Private"}
                            </span>
                        </div>
                    </div>
                    <div class="note-card-content">${typeof formatUserNoteHtml === "function" ? formatUserNoteHtml(note.content) : escapeHtml(note.content)}</div>
                    <div class="note-card-footer">
                        <span class="note-card-meta">Güncellendi: ${typeof formatUserNoteDate === "function" ? formatUserNoteDate(note.updatedAt || note.createdAt) : ""}</span>
                        <div class="note-card-actions">
                            <button type="button" onclick="toggleMyNotePrivacy('${note.id}')" style="background-color: ${note.isPublic ? "var(--pomodoro-accent)" : "var(--countdown-fill)"}; color: var(--header-text);">
                                <i class="fas ${note.isPublic ? "fa-lock" : "fa-earth-europe"}"></i> ${note.isPublic ? "Private Yap" : "Public Yap"}
                            </button>
                            <button type="button" onclick="moveMyNote('${note.id}', -1)" ${index === 0 ? "disabled" : ""} style="background-color: var(--button-bg); color: var(--header-text);">
                                <i class="fas fa-arrow-up"></i> Yukarı
                            </button>
                            <button type="button" onclick="moveMyNote('${note.id}', 1)" ${index === filteredNotes.length - 1 ? "disabled" : ""} style="background-color: var(--button-bg); color: var(--header-text);">
                                <i class="fas fa-arrow-down"></i> Aşağı
                            </button>
                            <button type="button" onclick="editMyNote('${note.id}')" style="background-color: var(--accent-color); color: var(--header-text);">
                                <i class="fas fa-pen"></i> Düzenle
                            </button>
                            <button type="button" onclick="deleteMyNote('${note.id}')" style="background-color: var(--pomodoro-accent); color: var(--header-text);">
                                <i class="fas fa-trash"></i> Sil
                            </button>
                        </div>
                    </div>
                </article>
            `).join("");
        };

        editMyNote = (function(originalEditMyNote) {
            return function(noteId) {
                originalEditMyNote(noteId);
                const note = normalizeUserNotes(userNotes || []).find(item => item.id === noteId);
                if (note) {
                    ensureNotesFolderUi();
                    const select = document.getElementById("my-note-folder-select");
                    if (select) select.value = note.folderId || NOTE_FOLDER_DEFAULT_ID;
                }
            };
        })(typeof editMyNote === "function" ? editMyNote : () => {});

        resetMyNoteEditor = (function(originalResetMyNoteEditor) {
            return function() {
                originalResetMyNoteEditor();
                ensureNotesFolderUi();
                const select = document.getElementById("my-note-folder-select");
                if (select) {
                    const targetFolder = activeNoteFolderId !== NOTE_FOLDER_ALL_ID ? activeNoteFolderId : NOTE_FOLDER_DEFAULT_ID;
                    select.value = targetFolder;
                }
            };
        })(typeof resetMyNoteEditor === "function" ? resetMyNoteEditor : () => {});

        saveMyNote = function() {
            if (!currentUser) {
                safeShowAlert("Not kaydetmek için giriş yapmalısın.");
                return;
            }

            const title = document.getElementById("my-note-title-input")?.value.trim() || "";
            const content = document.getElementById("my-note-content-input")?.value.trim() || "";
            const folderId = document.getElementById("my-note-folder-select")?.value || NOTE_FOLDER_DEFAULT_ID;

            if (title.length < 2) return safeShowAlert("Not başlığı en az 2 karakter olmalı.");
            if (content.length < 3) return safeShowAlert("Not içeriği en az 3 karakter olmalı.");

            const normalizedNotes = normalizeUserNotes(userNotes || []);
            const now = new Date().toISOString();

            if (activeUserNoteId) {
                userNotes = normalizedNotes.map(note => note.id === activeUserNoteId
                    ? { ...note, title, content, folderId, isPublic: activeUserNoteVisibility, updatedAt: now }
                    : note
                );
            } else {
                userNotes = [
                    { id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, title, content, folderId, isPublic: activeUserNoteVisibility, createdAt: now, updatedAt: now },
                    ...normalizedNotes
                ];
            }

            saveData();
            renderMyNotesPanel();
            if (typeof syncProfileNotesPreview === "function") {
                syncProfileNotesPreview();
            }
            safeShowAlert(activeUserNoteId ? "Not güncellendi." : "Yeni not kaydedildi.", "success");
            resetMyNoteEditor();
        };
    }

    function patchPersistenceLayer() {
        const originalBuildUserPayload = typeof buildUserPayload === "function" ? buildUserPayload : null;
        buildUserPayload = function() {
            scheduleData = sanitizeScheduleData(scheduleData || {});
            refreshCurrentTotals();

            const basePayload = originalBuildUserPayload ? originalBuildUserPayload() : {};
            const syncTimestamp = Date.now();
            const resolvedEmail = currentUser?.email || basePayload.email || "";
            const questionCounters = buildQuestionCounterPayload(scheduleData);
            const activeTimerRecord = timerState.session ? serializeTimerSession(timerState.session) : null;
            const timerPendingSeconds = timerState.session?.isRunning
                ? getPendingTimerDelta(timerState.session)
                : 0;
            const legacyWorkingStartedAt = timerState.session?.isRunning
                ? Math.max(
                    parseInteger(timerState.session.startedAtMs, 0),
                    syncTimestamp - (Math.max(0, getTimerElapsedSeconds(timerState.session)) * 1000)
                )
                : 0;
            const titleInfo = buildResolvedTitleInfo({
                uid: currentUser?.uid || basePayload.uid || "",
                schedule: scheduleData,
                activeTimer: activeTimerRecord,
                selectedTitleId: getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {}, basePayload),
                titleAwards: getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {}, basePayload)
            });
            const adminProfile = typeof getAdminProfileMeta === "function"
                ? getAdminProfileMeta(currentUsername, resolvedEmail)
                : {
                    isAdmin: typeof isCurrentAdmin === "function" ? isCurrentAdmin() : false,
                    role: (typeof isCurrentAdmin === "function" && isCurrentAdmin()) ? "admin" : "user",
                    adminTitle: (typeof isCurrentAdmin === "function" && isCurrentAdmin()) ? "Kurucu Admin" : ""
                };
            return {
                ...basePayload,
                name: currentUsername || basePayload.name || basePayload.username || resolvedEmail?.split?.("@")?.[0] || "Kullanici",
                email: resolvedEmail,
                ...adminProfile,
                emailVerified: !!currentUser?.emailVerified,
                studyTrack: studyTrack || basePayload.studyTrack || "",
                selectedSubjects: typeof normalizeSelectedSubjects === "function"
                    ? normalizeSelectedSubjects(studyTrack || "", selectedSubjects || [])
                    : (selectedSubjects || []),
                notes: normalizeUserNotes(userNotes || []),
                noteFolders: normalizeNoteFolders(noteFolders),
                schedule: scheduleData,
                totalWorkedSeconds: totalWorkedSecondsAllTime || 0,
                totalStudyTime: totalWorkedSecondsAllTime || 0,
                totalTime: Math.max(0, parseInteger(totalWorkedSecondsAllTime, 0)) * 1000,
                totalQuestionsAllTime: totalQuestionsAllTime || 0,
                ...questionCounters,
                selectedTitleId: titleInfo.selectedTitleId,
                titleAwards: titleInfo.titleAwards,
                dailyStudyTime: getCurrentDayWorkedSeconds(),
                dailyStudyDateKey: getCurrentDayMeta(new Date()).dateKey,
                currentSessionTime: timerPendingSeconds,
                legacyWorkingStartedAt,
                activeTimer: activeTimerRecord,
                isWorking: isTimerRecordRunning(timerState.session),
                isRunning: !!timerState.session?.isRunning,
                lastSyncTime: syncTimestamp,
                lastTimerSyncAt: syncTimestamp
            };
        };

        if (typeof getCurrentUserSeedData === "function") {
            const originalGetCurrentUserSeedData = getCurrentUserSeedData;
            getCurrentUserSeedData = function() {
                const seed = originalGetCurrentUserSeedData();
                const titleInfo = buildResolvedTitleInfo({
                    uid: currentUser?.uid || seed.uid || "",
                    schedule: scheduleData,
                    activeTimer: timerState.session ? serializeTimerSession(timerState.session) : null,
                    selectedTitleId: getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {}, seed),
                    titleAwards: getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {}, seed)
                });
                return {
                    ...seed,
                    name: currentUsername || seed.name || seed.username || currentUser?.email?.split?.("@")?.[0] || "Kullanici",
                    noteFolders: normalizeNoteFolders(noteFolders),
                    totalStudyTime: totalWorkedSecondsAllTime || 0,
                    totalTime: Math.max(0, parseInteger(totalWorkedSecondsAllTime, 0)) * 1000,
                    selectedTitleId: titleInfo.selectedTitleId,
                    titleAwards: titleInfo.titleAwards,
                    dailyStudyTime: getCurrentDayWorkedSeconds(),
                    dailyStudyDateKey: getCurrentDayMeta(new Date()).dateKey,
                    currentSessionTime: timerState.session?.isRunning ? getPendingTimerDelta(timerState.session) : 0,
                    activeTimer: timerState.session ? serializeTimerSession(timerState.session) : null,
                    isRunning: !!timerState.session?.isRunning,
                    lastSyncTime: Date.now(),
                    emailVerified: !!currentUser?.emailVerified
                };
            };
        }
    }

    function patchUserWritePipeline() {
        saveData = function(options = {}) {
            if (!currentUser) return Promise.resolve();
            return scheduleCurrentUserSave({
                label: "saveData",
                authorized: options.authorized === true,
                immediate: options.immediate === true
            }).catch(error => {
                console.error("Bulut kaydi basarisiz:", error);
                safeShowAlert("Veriler kaydedilirken bir hata olustu.");
            });
        };

        saveToFirestore = function() {
            if (!currentUser) return Promise.resolve();
            return flushScheduledCurrentUserSave({
                notify: true,
                label: "saveToFirestore"
            }).catch(error => {
                console.error("Bulut kaydi basarisiz:", error);
                safeShowAlert("Veriler kaydedilirken bir hata olustu.");
            });
        };

        updateWorkingStatus = function() {
            // Legacy pomodoro writer is disabled; realtime timer payload owns this field.
        };
    }

    function neutralizeLegacyTimerRuntime() {
        clearLegacyPomodoroStorage();
        stopTimerLoops();
        isRunning = false;
    }

    function publishTimerBridge() {
        window.codexTimerBridge = {
            showModal: (...args) => typeof showPomodoroModal === "function" ? showPomodoroModal.apply(window, args) : undefined,
            hideModal: (...args) => typeof hidePomodoroModal === "function" ? hidePomodoroModal.apply(window, args) : undefined,
            updateInputs: (...args) => typeof updateTimerFromInputsAndReset === "function" ? updateTimerFromInputsAndReset.apply(window, args) : undefined,
            toggle: (...args) => typeof toggleTimer === "function" ? toggleTimer.apply(window, args) : undefined,
            save: (...args) => typeof saveWorkSession === "function" ? saveWorkSession.apply(window, args) : undefined,
            reset: (...args) => typeof resetTimer === "function" ? resetTimer.apply(window, args) : undefined
        };
    }

    function bindTimerModalControls() {
        const modal = document.getElementById("pomodoro-modal");
        if (!modal || modal.dataset.codexTimerControlsBound === "true") return;

        const bindAction = (selector, eventName, action, ...args) => {
            const node = modal.querySelector(selector);
            if (!node) return;
            node.removeAttribute("onclick");
            if (node.tagName === "BUTTON" && !node.getAttribute("type")) {
                node.setAttribute("type", "button");
            }
            node.addEventListener(eventName, event => {
                event.preventDefault();
                event.stopPropagation();
                const bridge = window.codexTimerBridge || {};
                const handler = typeof bridge[action] === "function" ? bridge[action] : null;
                if (handler) {
                    handler.apply(window, args);
                }
            });
        };

        bindAction(".pomodoro-close-btn", "click", "hideModal");
        bindAction("#start-pause-btn", "click", "toggle");
        bindAction("#save-btn", "click", "save");
        bindAction("#reset-btn", "click", "reset", true, true);
        bindAction("#study-hours", "input", "updateInputs");
        bindAction("#study-minutes", "input", "updateInputs");
        bindAction("#study-seconds", "input", "updateInputs");

        modal.dataset.codexTimerControlsBound = "true";
    }

    function patchLegacyWorkingStatusSync() {
        const originalUpdateWorkingStatus = typeof updateWorkingStatus === "function" ? updateWorkingStatus : null;
        if (!originalUpdateWorkingStatus || originalUpdateWorkingStatus.__codexLegacyWorkingPatched) return;

        const wrappedUpdateWorkingStatus = function(status) {
            if (!currentUser?.uid) {
                return originalUpdateWorkingStatus.apply(this, arguments);
            }

            const isWorking = !!status;
            const now = Date.now();
            const sessionElapsedSeconds = timerState.session?.isRunning
                ? Math.max(0, getTimerElapsedSeconds(timerState.session))
                : 0;
            const nextLegacyWorkingStartedAt = isWorking
                ? Math.max(
                    parseInteger(currentUserLiveDoc?.legacyWorkingStartedAt, 0),
                    timerState.session?.isRunning
                        ? Math.max(
                            parseInteger(timerState.session.startedAtMs, 0),
                            now - (sessionElapsedSeconds * 1000)
                        )
                        : now
                )
                : 0;
            const workingPatch = {
                isWorking,
                isRunning: isWorking,
                currentSessionTime: isWorking ? sessionElapsedSeconds : 0,
                legacyWorkingStartedAt: nextLegacyWorkingStartedAt,
                lastSyncTime: now,
                lastTimerSyncAt: now,
                totalTime: Math.max(0, parseInteger(totalWorkedSecondsAllTime, 0)) * 1000,
                activeTimer: isWorking && timerState.session ? serializeTimerSession(timerState.session) : null
            };

            currentUserLiveDoc = {
                ...(currentUserLiveDoc || {}),
                ...workingPatch
            };

            if (isWorking) {
                legacyWorkingPresenceByUserId.set(currentUser.uid, {
                    startedAtMs: nextLegacyWorkingStartedAt
                });
            } else {
                legacyWorkingPresenceByUserId.delete(currentUser.uid);
            }

            const cloudPayload = {
                ...(typeof buildUserPayload === "function" ? buildUserPayload() : {}),
                ...workingPatch
            };

            withManualFirestoreWrite(() => db.collection("users").doc(currentUser.uid).set(workingPatch, { merge: true }))
                .catch(error => {
                    console.error("Legacy calisma durumu buluta yazilamadi:", error);
                });
            syncLeaderboardSnapshotSafely(cloudPayload);

            return undefined;
        };

        wrappedUpdateWorkingStatus.__codexLegacyWorkingPatched = true;
        updateWorkingStatus = wrappedUpdateWorkingStatus;
    }

    function patchSignOutPreservation() {
        const originalSignOutUser = typeof signOutUser === "function" ? signOutUser : null;
        if (!originalSignOutUser || originalSignOutUser.__codexTimerPatched) return;

        const wrappedSignOutUser = function(...args) {
            if (timerState.session) {
                preserveTimerStateForRecovery(timerState.session, {
                    modalOpen: false,
                    includeRecovery: true
                });
            }
            return originalSignOutUser.apply(this, args);
        };

        wrappedSignOutUser.__codexTimerPatched = true;
        signOutUser = wrappedSignOutUser;
    }

    function patchProtectedOpeners() {
        ["openProfileModal", "openMyNotesModal", "openSupportModal", "openTitlesModal"].forEach(functionName => {
            const original = typeof window[functionName] === "function" ? window[functionName] : null;
            if (!original) return;
            window[functionName] = function(...args) {
                if (guardVerifiedAccess()) return;
                return original.apply(this, args);
            };
        });
    }

    function patchRenderSchedule() {
        const originalRenderSchedule = typeof renderSchedule === "function" ? renderSchedule : null;
        if (!originalRenderSchedule) return;

        renderSchedule = function() {
            scheduleData = sanitizeScheduleData(scheduleData || {});
            originalRenderSchedule();
            refreshQuestionSummaryCounters();
            renderQuestionTrackingEnhancements();
            updateLiveStudyPreview();
            refreshVisibleProfileModalFromLiveData();
            syncCurrentUserTitleAwardsIfNeeded();
        };
    }

    function attachRealtimeListeners() {
        auth.onAuthStateChanged(async user => {
            ensureVerificationCard();
            applyTurkishInputSupport();

            if (!user) {
                currentUser = null;
                currentUserLiveDoc = null;
                currentUserWriteChain = Promise.resolve();
                requiresEmailVerification = false;
                hasBootstrappedUsersRealtime = false;
                clearLoadedUserData();
                unsubscribeRealtimeLeaderboard();
                if (currentUserSaveTimer) {
                    clearTimeout(currentUserSaveTimer);
                    currentUserSaveTimer = null;
                }
                currentUserSaveNoticePending = false;
                currentUserSaveResolvers = [];
                stopTimerLoops();
                timerState.session = null;
                persistTimerSessionLocally(null);
                releaseTimerOwnership();
                clearLegacyPomodoroStorage();
                hideVerificationGate();
                renderTimerUi();
                if (typeof renderSchedule === "function") renderSchedule();
                if (typeof renderMyNotesPanel === "function") renderMyNotesPanel();
                return;
            }

            currentUser = user;
            localStorage.setItem(VERIFY_EMAIL_KEY, user.email || "");

            try {
                await user.reload();
            } catch (error) {
                console.error("Kullanici yenilenemedi:", error);
            }

            hideVerificationGate();
            hasBootstrappedUsersRealtime = false;
            subscribeRealtimeLeaderboard();
        });

        document.addEventListener("visibilitychange", () => {
            if (document.hidden && timerState.session?.isRunning) {
                touchTimerVisibility(Date.now(), { modalOpen: isTimerModalOpen(), persist: true });
                syncRealtimeTimer("visibility-hidden", {
                    activeSession: timerState.session,
                    currentSessionTime: getTimerElapsedSeconds(timerState.session),
                    userTriggeredWrite: true,
                    authorized: true
                }).catch(error => {
                    console.error("Gizli sekme timer senkronu basarisiz:", error);
                });
            } else if (!document.hidden && timerState.session?.isRunning && isTimerModalOpen()) {
                touchTimerVisibility(Date.now(), { modalOpen: true, persist: true });
                syncRealtimeTimer("visibility-visible", {
                    activeSession: timerState.session,
                    currentSessionTime: getTimerElapsedSeconds(timerState.session),
                    userTriggeredWrite: true,
                    authorized: true
                }).catch(error => {
                    console.error("Gorunur sekme timer senkronu basarisiz:", error);
                });
            }
        });

        window.addEventListener("beforeunload", () => {
            if (timerState.session?.isRunning) {
                persistTimerSessionLocally(timerState.session);
            }
            clearLegacyPomodoroStorage();
            releaseTimerOwnership();
        });
    }

    translateExtendedAuthError = function(error, mode = "login") {
        const existing = typeof translateAuthError === "function" ? translateAuthError(error, mode) : "";
        if (existing && existing !== "Bir hata olustu. Lutfen tekrar dene.") return existing;

        const rawMessage = String(error?.message || "").toUpperCase();
        if (rawMessage.includes("CONFIGURATION_NOT_FOUND") || rawMessage.includes("PASSWORD_LOGIN_DISABLED") || rawMessage.includes("OPERATION_NOT_ALLOWED")) {
            return "Firebase Authentication panelinde Email/Password girisini etkinlestir.";
        }
        if (rawMessage.includes("INVALID_LOGIN_CREDENTIALS")) {
            return mode === "login" ? "E-posta ya da sifre hatali." : "Girdigin bilgiler gecersiz.";
        }
        if (rawMessage.includes("INVALID_API_KEY") || rawMessage.includes("API KEY NOT VALID")) {
            return "Firebase API anahtari gecersiz ya da kisitli.";
        }
        if (rawMessage.includes("APP_NOT_AUTHORIZED") || rawMessage.includes("UNAUTHORIZED_DOMAIN")) {
            return "Bu site Firebase Auth icin yetkili degil. Authorized domains listesine alan adini ekle.";
        }

        const codeSuffix = error?.code ? ` (${error.code})` : "";
        return `Bir hata olustu${codeSuffix}. Firebase Authentication ayarlarini kontrol et.`;
    };

    function initUpgradeLayer() {
        installManualWriteIntentCapture();
        installStrictFirestoreSafetyLayer();
        ensureVerificationCard();
        ensureTimerModeUi();
        ensureSubjectQuestionModal();
        ensureNavyThemeButton();
        ensureNotesFolderUi();
        applyTurkishInputSupport();
        installVisibleUiTextNormalizer();
        refreshVerificationCooldownUI();
        neutralizeLegacyTimerRuntime();

        patchPersistenceLayer();
        patchUserWritePipeline();
        patchAuthFlows();
        patchQuestionTracking();
        patchTaskInteractions();
        patchNotesFolders();
        patchTimerControls();
        patchLegacyWorkingStatusSync();
        patchSignOutPreservation();
        publishTimerBridge();
        bindTimerModalControls();
        patchProfileCopy();
        patchLeaderboardRealtime();
        patchProtectedOpeners();
        patchRenderSchedule();
        attachRealtimeListeners();
        ensureCalendarBoundaryWatcher();

        setTimerMode(timerState.mode, { persist: false, keepSession: true });
        if (!timerState.session) {
            timerState.session = createEmptyTimerSession(timerState.mode);
            if (timerState.mode === "pomodoro") {
                timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
            }
        }
        renderTimerUi();
        renderQuestionTrackingEnhancements();
        renderNoteFolderControls();
        normalizeVisibleUiText(document.body);
        observeTimerOwnership();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initUpgradeLayer);
    } else {
        initUpgradeLayer();
    }
})();

