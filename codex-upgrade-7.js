(() => {
    const VERIFY_MESSAGE = "Lutfen e-posta adresini kontrol et. Dogrulama baglantisi gonderildi; spam/junk klasorunu da kontrol et.";
    const RESET_PASSWORD_MESSAGE = "Sifre sifirlama baglantisi e-posta adresine gonderildi. Spam/junk klasorunu da kontrol et.";
    const VERIFY_COOLDOWN_MS = 30000;
    const TIMER_SYNC_MS = 10 * 60 * 1000;
    const TIMER_FORCED_CHECKPOINT_MS = 60 * 60 * 1000;
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
    const TIMER_FINALIZED_STORAGE_KEY = "codexRealtimeTimerFinalizedV1";
    const TIMER_MODE_KEY = "codexRealtimeTimerModeV1";
    const TIMER_TRACK_KEY = "codexRealtimeTimerTrackV1";
    const ADMIN_TIMER_RESET_KEY = "codexAdminTimerResetAckV1";
    const DAILY_SUPPORT_NOTICE_KEY = "codexDailySupportNoticeV1";
    const DAILY_TIMER_NOTICE_KEY = "codexDailyTimerNoticeV1";
    const TIMER_NOTICE_DISABLE_KEY = "codexTimerNoticeDisabledV1";
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
    let currentUserPublicProfileDoc = null;
    let currentUserPublicProfileBootstrapPromise = null;
    let currentUserProfileHydrated = false;
    let currentUserHasRemoteProfile = false;
    let leaderboardRealtimeDocs = [];
    let leaderboardProfileSourceDocs = [];
    let leaderboardLiveSourceDocs = [];
    let legacyWorkingPresenceByUserId = new Map();
    let inferredWorkingPresenceByUserId = new Map();
    let observedWorkingBadgeByUserId = new Map();
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
    let lastTimerDayBoundaryResetSignature = "";
    let hasBootstrappedUsersRealtime = false;

    const timerState = {
        mode: normalizeTimerMode(localStorage.getItem(TIMER_MODE_KEY) || "pomodoro"),
        session: null,
        syncing: false,
        transitioning: false,
        reconciling: false,
        lastModalSeenAt: Date.now()
    };

    const timerDrafts = {
        pomodoro: null,
        stopwatch: null,
        "break-pomodoro": null,
        "break-stopwatch": null
    };

    const analyticsState = {
        tab: "daily",
        selectedDateKey: "",
        selectedWeekKey: ""
    };

    function normalizeTimerMode(mode = "") {
        const normalizedMode = String(mode || "").trim().toLowerCase();
        if (normalizedMode === "stopwatch") return "stopwatch";
        if (normalizedMode === "break-pomodoro") return "break-pomodoro";
        if (normalizedMode === "break-stopwatch") return "break-stopwatch";
        return "pomodoro";
    }

    function isBreakTimerMode(mode = timerState.mode) {
        return normalizeTimerMode(mode).startsWith("break-");
    }

    function isStopwatchTimerMode(mode = timerState.mode) {
        const normalizedMode = normalizeTimerMode(mode);
        return normalizedMode === "stopwatch" || normalizedMode === "break-stopwatch";
    }

    function isCountdownTimerMode(mode = timerState.mode) {
        return !isStopwatchTimerMode(mode);
    }

    function getTimerTrack(mode = timerState.mode) {
        return isBreakTimerMode(mode) ? "break" : "study";
    }

    function getTimerModeLabel(mode = timerState.mode) {
        const normalizedMode = normalizeTimerMode(mode);
        if (normalizedMode === "stopwatch") return "Kronometre";
        if (normalizedMode === "break-stopwatch") return "Mola Kronometresi";
        if (normalizedMode === "break-pomodoro") return "Mola Geri Sayımı";
        return "Pomodoro";
    }

    function getTimerContextTitle(mode = timerState.mode) {
        return isBreakTimerMode(mode) ? "MOLA ZAMANI" : "ODAK ZAMANI";
    }

    function getTimerDraft(mode = timerState.mode) {
        return timerDrafts[normalizeTimerMode(mode)] || null;
    }

    function setTimerDraft(session = null, mode = session?.mode || timerState.mode) {
        const normalizedMode = normalizeTimerMode(mode);
        timerDrafts[normalizedMode] = session ? { ...session } : null;
        return timerDrafts[normalizedMode];
    }

    function safeShowAlert(message, type) {
        if (typeof showAlert === "function") {
            showAlert(message, type);
        }
    }

    function safeStorageGet(key, fallback = "") {
        try {
            return localStorage.getItem(key) ?? fallback;
        } catch (error) {
            return fallback;
        }
    }

    function safeStorageSet(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (error) {
            return false;
        }
    }

    function buildPerUserDailyNoticeKey(baseKey, user = currentUser, referenceDate = new Date()) {
        const dateKey = getCurrentDayMeta(referenceDate).dateKey;
        const uid = String(user?.uid || "guest");
        return `${baseKey}:${uid}:${dateKey}`;
    }

    function hasDailyNoticeBeenHandled(baseKey, user = currentUser, referenceDate = new Date()) {
        const key = buildPerUserDailyNoticeKey(baseKey, user, referenceDate);
        return safeStorageGet(key, "") === "1";
    }

    function markDailyNoticeHandled(baseKey, user = currentUser, referenceDate = new Date()) {
        const key = buildPerUserDailyNoticeKey(baseKey, user, referenceDate);
        safeStorageSet(key, "1");
    }

    function ensureCodexGuidanceModal() {
        let modal = document.getElementById("codex-guidance-modal");
        if (modal) return modal;

        if (!document.getElementById("codex-guidance-modal-style")) {
            const style = document.createElement("style");
            style.id = "codex-guidance-modal-style";
            style.textContent = `
                #codex-guidance-modal {
                    position: fixed;
                    inset: 0;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    padding: 18px;
                    background: rgba(7, 10, 19, 0.62);
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    z-index: 6500;
                }
                #codex-guidance-modal.is-visible {
                    display: flex;
                }
                #codex-guidance-modal .codex-guidance-card {
                    width: min(100%, 560px);
                    padding: 24px 22px 20px;
                    border-radius: 28px;
                    background:
                        linear-gradient(180deg, rgba(255,255,255,0.11), rgba(255,255,255,0.04)),
                        rgba(25, 14, 41, 0.96);
                    border: 1px solid rgba(220, 196, 255, 0.16);
                    box-shadow: 0 30px 60px rgba(0, 0, 0, 0.34);
                    color: #f6ebff;
                }
                #codex-guidance-modal .codex-guidance-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 12px;
                    padding: 8px 12px;
                    border-radius: 999px;
                    background: rgba(236, 184, 255, 0.12);
                    color: #ffd8fb;
                    font-size: 0.82rem;
                    font-weight: 800;
                    letter-spacing: 0.02em;
                    text-transform: uppercase;
                }
                #codex-guidance-modal .codex-guidance-title {
                    margin: 0 0 10px;
                    color: #fff7ff;
                    font-size: clamp(1.2rem, 4.3vw, 1.65rem);
                    line-height: 1.2;
                }
                #codex-guidance-modal .codex-guidance-body {
                    color: rgba(246, 235, 255, 0.86);
                    font-size: 0.98rem;
                    line-height: 1.7;
                }
                #codex-guidance-modal .codex-guidance-body strong {
                    color: #fff4ff;
                }
                #codex-guidance-modal .codex-guidance-actions {
                    display: flex;
                    flex-wrap: wrap;
                    justify-content: flex-end;
                    gap: 10px;
                    margin-top: 18px;
                }
                #codex-guidance-modal .codex-guidance-actions button {
                    min-height: 46px;
                    padding: 11px 16px;
                    border-radius: 16px;
                }
                #codex-guidance-modal .codex-guidance-secondary {
                    background: rgba(255, 255, 255, 0.08) !important;
                    color: #f6ebff !important;
                }
                #codex-guidance-modal .codex-guidance-primary {
                    background: linear-gradient(135deg, #ff8bd6, #7b43c9) !important;
                    color: #ffffff !important;
                }
                @media (max-width: 560px) {
                    #codex-guidance-modal {
                        padding: 12px;
                    }
                    #codex-guidance-modal .codex-guidance-card {
                        padding: 20px 16px 16px;
                        border-radius: 22px;
                    }
                    #codex-guidance-modal .codex-guidance-actions {
                        flex-direction: column-reverse;
                    }
                    #codex-guidance-modal .codex-guidance-actions button {
                        width: 100%;
                    }
                }
            `;
            document.head.appendChild(style);
        }

        modal = document.createElement("div");
        modal.id = "codex-guidance-modal";
        modal.innerHTML = `
            <div class="codex-guidance-card" role="dialog" aria-modal="true" aria-labelledby="codex-guidance-title">
                <div class="codex-guidance-badge"><i class="fas fa-circle-info"></i><span>Bilgilendirme</span></div>
                <h3 id="codex-guidance-title" class="codex-guidance-title"></h3>
                <div id="codex-guidance-body" class="codex-guidance-body"></div>
                <div class="codex-guidance-actions">
                    <button id="codex-guidance-secondary" type="button" class="codex-guidance-secondary" style="display:none;"></button>
                    <button id="codex-guidance-primary" type="button" class="codex-guidance-primary">Tamam</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    function hideCodexGuidanceModal() {
        const modal = document.getElementById("codex-guidance-modal");
        if (!modal) return;
        modal.classList.remove("is-visible");
    }

    function showCodexGuidanceModal(options = {}) {
        const modal = ensureCodexGuidanceModal();
        const titleNode = document.getElementById("codex-guidance-title");
        const bodyNode = document.getElementById("codex-guidance-body");
        const primaryButton = document.getElementById("codex-guidance-primary");
        const secondaryButton = document.getElementById("codex-guidance-secondary");

        if (!modal || !titleNode || !bodyNode || !primaryButton || !secondaryButton) return;

        titleNode.textContent = String(options.title || "Bilgilendirme");
        bodyNode.innerHTML = String(options.bodyHtml || "");
        primaryButton.textContent = String(options.primaryText || "Tamam");
        primaryButton.onclick = () => {
            hideCodexGuidanceModal();
            if (typeof options.onPrimary === "function") {
                options.onPrimary();
            }
        };

        if (options.secondaryText) {
            secondaryButton.style.display = "inline-flex";
            secondaryButton.textContent = String(options.secondaryText);
            secondaryButton.onclick = () => {
                hideCodexGuidanceModal();
                if (typeof options.onSecondary === "function") {
                    options.onSecondary();
                }
            };
        } else {
            secondaryButton.style.display = "none";
            secondaryButton.onclick = null;
            secondaryButton.textContent = "";
        }

        modal.classList.add("is-visible");
    }

    function maybeShowDailySupportGuidance(referenceDate = new Date()) {
        if (!currentUser || hasDailyNoticeBeenHandled(DAILY_SUPPORT_NOTICE_KEY, currentUser, referenceDate)) return false;

        showCodexGuidanceModal({
            title: "Kısa Bir Hatırlatma",
            bodyHtml: `
                <strong>Site içinde hata, bug, eksik gördüğün bir kısım ya da farklı bir fikrin varsa</strong>
                ana ekrandaki <strong>Destek</strong> bölümünden admine yazabilirsin.
                <br><br>
                İstersen <strong>Instagram: @cosxomer</strong> hesabından da ulaşabilirsin.
            `,
            primaryText: "Tamam",
            onPrimary: () => {
                markDailyNoticeHandled(DAILY_SUPPORT_NOTICE_KEY, currentUser, referenceDate);
            }
        });

        return true;
    }

    function maybeShowDailyTimerGuidance(referenceDate = new Date()) {
        if (!currentUser) return false;
        if (safeStorageGet(`${TIMER_NOTICE_DISABLE_KEY}:${currentUser.uid}`, "") === "1") return false;
        if (hasDailyNoticeBeenHandled(DAILY_TIMER_NOTICE_KEY, currentUser, referenceDate)) return false;

        showCodexGuidanceModal({
            title: "Kronometre İçin Kısa Not",
            bodyHtml: `
                Sistem, süre kaybını azaltmak için güçlendirildi ve süreler arka planda da mümkün olduğunca korunmaya çalışıyor.
                Yine de uygulama <strong>web tabanlı</strong> olduğu için bazı cihazlar sekmeyi uyku moduna alıp veri senkronunu geciktirebilir.
                <br><br>
                Bu yüzden daha güvenli kullanım için <strong>1-2 saatte bir kronometreyi durdurup yeniden başlatman ya da kaydetmen</strong> önerilir.
                Beklenmedik bir sıfırlanma ya da süre eksilmesi görürsen admine bildirmen yeterli olur.
            `,
            primaryText: "Tamam",
            secondaryText: "Bir Daha Hatırlatma",
            onPrimary: () => {
                markDailyNoticeHandled(DAILY_TIMER_NOTICE_KEY, currentUser, referenceDate);
            },
            onSecondary: () => {
                markDailyNoticeHandled(DAILY_TIMER_NOTICE_KEY, currentUser, referenceDate);
                safeStorageSet(`${TIMER_NOTICE_DISABLE_KEY}:${currentUser.uid}`, "1");
            }
        });

        return true;
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

    function getDateKeyFromTimestamp(timestamp = 0) {
        const safeTimestamp = Math.max(0, parseInteger(timestamp, 0));
        if (!safeTimestamp) return "";
        return getCurrentDayMeta(new Date(safeTimestamp)).dateKey;
    }

    function getNextDayStartMsForDateKey(dateKey = "") {
        const normalizedDateKey = String(dateKey || "").trim();
        if (!normalizedDateKey) return 0;

        const dayStart = new Date(`${normalizedDateKey}T00:00:00`);
        if (Number.isNaN(dayStart.getTime())) return 0;

        const nextDay = new Date(dayStart);
        nextDay.setDate(nextDay.getDate() + 1);
        return nextDay.getTime();
    }

    function getTimerSessionDateKey(session = null, referenceDate = new Date()) {
        if (!session || typeof session !== "object") {
            return getCurrentDayMeta(referenceDate).dateKey;
        }

        const explicitDateKey = String(
            session.sessionDateKey
            || session.dayDateKey
            || session.dateKey
            || ""
        ).trim();
        if (explicitDateKey) return explicitDateKey;

        const inferredDateKey = getDateKeyFromTimestamp(
            parseInteger(session.startedAtMs, 0)
            || getTimerLastSeenAt(session)
            || parseInteger(session.updatedAtMs, 0)
        );

        return inferredDateKey || getCurrentDayMeta(referenceDate).dateKey;
    }

    function hasTimerSessionCrossedDayBoundary(session = null, referenceDate = new Date()) {
        if (!session) return false;
        return getTimerSessionDateKey(session, referenceDate) !== getCurrentDayMeta(referenceDate).dateKey;
    }

    function buildFreshTimerSession(mode = timerState.mode, referenceDate = new Date(), sourceSession = null) {
        const normalizedMode = normalizeTimerMode(mode);
        const freshSession = createEmptyTimerSession(normalizedMode, referenceDate);

        if (isCountdownTimerMode(normalizedMode)) {
            const preservedTargetDuration = Math.max(0, parseInteger(sourceSession?.targetDurationSeconds, 0));
            freshSession.targetDurationSeconds = preservedTargetDuration || getPomodoroSeedSeconds();
        }

        return freshSession;
    }

    function finalizeTimerSessionForNewDay(session = timerState.session, referenceDate = new Date(), options = {}) {
        if (!session) {
            return {
                didReset: false,
                committedSeconds: 0,
                nextSession: null,
                resetSignature: ""
            };
        }

        const todayMeta = getCurrentDayMeta(referenceDate);
        const sessionDateKey = getTimerSessionDateKey(session, referenceDate);

        if (!sessionDateKey || sessionDateKey === todayMeta.dateKey) {
            return {
                didReset: false,
                committedSeconds: 0,
                nextSession: null,
                resetSignature: ""
            };
        }

        const boundaryMs = getNextDayStartMsForDateKey(sessionDateKey) || referenceDate.getTime();
        let committedSeconds = 0;

        if (options.commitElapsed !== false) {
            committedSeconds = applyPendingTimerDelta(session, boundaryMs);
            const boundaryElapsedSeconds = getTimerElapsedSeconds(session, boundaryMs);
            session.lastPersistedElapsedSeconds = Math.max(
                parseInteger(session.lastPersistedElapsedSeconds, 0),
                boundaryElapsedSeconds
            );
            session.baseElapsedSeconds = boundaryElapsedSeconds;
        }

        if (typeof refreshCurrentTotals === "function") {
            refreshCurrentTotals();
        }

        if (options.persistRecovery !== false && currentUser?.uid && (committedSeconds > 0 || hasAnyScheduleEntries(scheduleData || {}))) {
            persistTimerRecoverySnapshot();
        }

        return {
            didReset: true,
            committedSeconds,
            nextSession: buildFreshTimerSession(session.mode, referenceDate, session),
            wasRunning: !!session.isRunning,
            sessionDateKey,
            todayDateKey: todayMeta.dateKey,
            resetSignature: currentUser?.uid ? `${currentUser.uid}:${sessionDateKey}:${todayMeta.dateKey}` : ""
        };
    }

    function scheduleTimerDayBoundaryResetSync(referenceDate = new Date(), resetSignature = "") {
        if (!currentUser?.uid) return false;

        queueAutoDailyResetSync(referenceDate);

        const safeSignature = String(resetSignature || "").trim();
        if (!safeSignature || lastTimerDayBoundaryResetSignature === safeSignature) {
            return false;
        }

        lastTimerDayBoundaryResetSignature = safeSignature;
        setTimeout(() => {
            syncRealtimeTimer("day-boundary-reset", {
                activeSession: null,
                currentSessionTime: 0,
                clearActive: true,
                userTriggeredWrite: true,
                authorized: true
            }).catch(error => {
                if (lastTimerDayBoundaryResetSignature === safeSignature) {
                    lastTimerDayBoundaryResetSignature = "";
                }
                console.error("Gun degisim timer sifirlama senkronu basarisiz:", error);
            });
        }, 0);

        return true;
    }

    function resetLocalTimerSessionForNewDay(referenceDate = new Date(), options = {}) {
        const resetState = finalizeTimerSessionForNewDay(timerState.session, referenceDate, options);
        if (!resetState.didReset) return resetState;

        logTimerReset("day-boundary-reset", {
            from: resetState.sessionDateKey,
            to: resetState.todayDateKey,
            committedSeconds: resetState.committedSeconds
        });
        stopTimerLoops();
        releaseTimerOwnership();
        isRunning = false;
        timerState.session = resetState.nextSession;
        timerDrafts[resetState.nextSession.mode] = { ...resetState.nextSession };
        persistTimerSessionLocally(null);
        clearTimerFinalizedSnapshot(currentUser?.uid || "");
        updateLocalActiveTimerSnapshot(null);

        currentUserLiveDoc = {
            ...(currentUserLiveDoc || {}),
            activeTimer: null,
            activeBreakTimer: null,
            isWorking: false,
            isRunning: false,
            isOnBreak: false,
            currentSessionTime: 0,
            currentBreakSessionTime: 0,
            legacyWorkingStartedAt: 0,
            dailyStudyDateKey: getCurrentDayMeta(referenceDate).dateKey,
            todayDateKey: getCurrentDayMeta(referenceDate).dateKey
        };

        if (options.syncRemote !== false) {
            scheduleTimerDayBoundaryResetSync(referenceDate, resetState.resetSignature);
        } else if (currentUser?.uid) {
            queueAutoDailyResetSync(referenceDate);
        }

        return resetState;
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
        const dayBoundaryResetState = resetLocalTimerSessionForNewDay(referenceDate);

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
        if (dayBoundaryResetState.didReset) {
            refreshLeaderboardOptimistically(null);
        }
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
        const mergedUserData = mergeCurrentUserProfileSources(
            userData || {},
            currentUserPublicProfileDoc || {},
            currentUserLiveDoc || {},
            getCurrentRuntimeProfileSeed()
        );
        const dailyResetState = getDailySnapshotResetState(mergedUserData || {});
        currentUserLiveDoc = dailyResetState.normalizedData;
        const resolvedEmail = String(currentUser?.email || currentUserLiveDoc?.email || "").trim();
        const resolvedUsername = pickPreferredProfileText(
            [currentUsername, currentUserLiveDoc?.username, currentUserLiveDoc?.name],
            { email: resolvedEmail }
        );
        if (resolvedUsername) {
            currentUsername = resolvedUsername;
        }
        const resolvedProfileImage = pickPreferredProfileText(
            [currentProfileImage, currentUserLiveDoc?.profileImage],
            { allowWeak: true }
        );
        if (resolvedProfileImage) {
            currentProfileImage = resolvedProfileImage;
        }
        const resolvedAbout = pickPreferredProfileText(
            [currentProfileAbout, currentUserLiveDoc?.about],
            { allowWeak: true }
        );
        if (resolvedAbout) {
            currentProfileAbout = resolvedAbout;
        }
        const resolvedAccountCreatedAt = pickPreferredProfileText(
            [currentAccountCreatedAt, currentUserLiveDoc?.accountCreatedAt],
            { allowWeak: true }
        );
        if (resolvedAccountCreatedAt) {
            currentAccountCreatedAt = resolvedAccountCreatedAt;
        }
        const resolvedStudyTrack = pickPreferredProfileText(
            [studyTrack, currentUserLiveDoc?.studyTrack],
            { allowWeak: true }
        );
        if (resolvedStudyTrack) {
            studyTrack = resolvedStudyTrack;
        }
        const resolvedSelectedSubjects = typeof normalizeSelectedSubjects === "function"
            ? normalizeSelectedSubjects(
                studyTrack || currentUserLiveDoc?.studyTrack || "",
                getFirstNonEmptyArray(selectedSubjects, currentUserLiveDoc?.selectedSubjects)
            )
            : getFirstNonEmptyArray(selectedSubjects, currentUserLiveDoc?.selectedSubjects);
        if (Array.isArray(resolvedSelectedSubjects) && resolvedSelectedSubjects.length) {
            selectedSubjects = [...resolvedSelectedSubjects];
        }
        mergeFreshDailySnapshotIntoLocalSchedule(currentUserLiveDoc);
        if (dailyResetState.needsSync) {
            queueAutoDailyResetSync();
        }
        if (currentUser?.uid && typeof saveCodexCachedUserProfile === "function") {
            saveCodexCachedUserProfile(currentUser.uid, currentUserLiveDoc, currentUser);
        }

        const foreignTimer = getFreshForeignActiveTimer(currentUserLiveDoc);
        if (!foreignTimer || !timerState.session?.isRunning) return false;
        if (hasTimerControl && getTimerOwnerId() === timerInstanceId) return false;

        stopTimerLoops();
        isRunning = false;
        persistTimerSessionLocally(null);
        releaseTimerOwnership();

        timerState.session = createEmptyTimerSession(timerState.mode);
        if (isCountdownTimerMode(timerState.mode)) {
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
        const visibleSession = hasTimerSessionCrossedDayBoundary(activeSession) ? null : activeSession;
        const shouldExposePresence = !!visibleSession && !isBreakTimerMode(visibleSession.mode);
        const activeTimerRecord = shouldExposePresence ? serializeTimerSession(visibleSession) : null;
        const pendingSeconds = shouldExposePresence && visibleSession?.isRunning ? getPendingTimerDelta(visibleSession) : 0;

        currentUserLiveDoc = {
            ...baseDoc,
            activeTimer: activeTimerRecord,
            isWorking: isTimerVisibleForLeaderboard(activeTimerRecord),
            isRunning: shouldExposePresence && !!visibleSession?.isRunning,
            currentSessionTime: pendingSeconds,
            lastTimerSyncAt: Date.now()
        };
    }

    function normalizeAdminTimeAdjustment(adjustment = null) {
        if (!adjustment || typeof adjustment !== "object") return null;

        const token = String(adjustment.token || adjustment.requestedAt || "").trim();
        const dateKey = String(adjustment.dateKey || "").trim();
        const weekKey = String(adjustment.weekKey || "").trim();
        const scope = ["today", "yesterday", "week", "total"].includes(adjustment.scope) ? adjustment.scope : "today";
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
        const appliedWeekSeconds = Math.max(
            0,
            parseInteger(adjustment.appliedWeekSeconds, 0),
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
            appliedDaySeconds,
            appliedWeekSeconds
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

    function buildStudySessionId(startTime, endTime, mode = "study") {
        const safeStart = Math.max(0, parseInteger(startTime, 0));
        const safeEnd = Math.max(safeStart, parseInteger(endTime, safeStart));
        return `${String(mode || "study").trim() || "study"}:${safeStart}:${safeEnd}`;
    }

    function formatStudySessionClock(timestampMs) {
        const safeTimestamp = Math.max(0, parseInteger(timestampMs, 0));
        if (!safeTimestamp) return "--:--";
        return new Date(safeTimestamp).toLocaleTimeString("tr-TR", {
            hour: "2-digit",
            minute: "2-digit"
        });
    }

    function buildStudySessionHourRange(startTime, endTime) {
        return `${formatStudySessionClock(startTime)}–${formatStudySessionClock(endTime)}`;
    }

    function normalizeStudySessionEntry(entry = {}) {
        const safeStartTime = Math.max(
            0,
            parseInteger(entry.startTime, 0),
            parseInteger(entry.startMs, 0)
        );
        const safeEndTime = Math.max(
            safeStartTime,
            parseInteger(entry.endTime, safeStartTime),
            parseInteger(entry.endMs, safeStartTime)
        );
        const safeDurationMs = Math.max(
            0,
            parseInteger(entry.durationMs, 0),
            parseInteger(entry.duration, safeEndTime - safeStartTime),
            safeEndTime - safeStartTime
        );
        const safeDateKey = String(
            getDateKeyFromTimestamp(safeStartTime)
            || entry.date
            || entry.dateKey
            || ""
        ).trim();
        const mode = normalizeTimerMode(String(entry.mode || "pomodoro").trim() || "pomodoro");
        const type = String(entry.type || (isBreakTimerMode(mode) ? "break" : "study")).trim() || "study";
        return {
            id: String(entry.id || buildStudySessionId(safeStartTime, safeEndTime, mode)).trim(),
            startTime: safeStartTime,
            endTime: safeEndTime,
            durationMs: safeDurationMs,
            duration: safeDurationMs,
            date: safeDateKey,
            dateKey: safeDateKey,
            dayOfWeek: parseInteger(entry.dayOfWeek, safeStartTime ? ((new Date(safeStartTime).getDay() + 6) % 7) : 0),
            mode,
            type,
            hourRange: String(entry.hourRange || buildStudySessionHourRange(safeStartTime, safeEndTime)).trim(),
            questions: Math.max(0, parseInteger(entry.questions, 0))
        };
    }

    function normalizeStudySessions(list = []) {
        const sessions = Array.isArray(list) ? list : [];
        const seen = new Set();
        return sessions
            .map(item => normalizeStudySessionEntry(item || {}))
            .filter(item => item.startTime > 0 && item.endTime > item.startTime)
            .filter(item => {
                if (!item.id || seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
            })
            .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
    }

    function mergeStudySessions(...lists) {
        return normalizeStudySessions(lists.flatMap(list => Array.isArray(list) ? list : []));
    }

    function hasValidatedStudyActivityForDate(dayData = {}, expectedDateKey = "") {
        const normalizedExpectedDateKey = String(expectedDateKey || "").trim();
        return normalizeStudySessions(dayData?.studySessions || []).some(session => {
            const sessionDateKey = String(
                session?.dateKey
                || session?.date
                || getDateKeyFromTimestamp(session?.startTime)
                || ""
            ).trim();
            if (normalizedExpectedDateKey && sessionDateKey !== normalizedExpectedDateKey) {
                return false;
            }
            return parseInteger(session?.startTime, 0) > 0 && parseInteger(session?.endTime, 0) > parseInteger(session?.startTime, 0);
        });
    }

    function appendStudySessionSegment(startTime, endTime, mode = timerState.mode) {
        const safeStartTime = Math.max(0, parseInteger(startTime, 0));
        const safeEndTime = Math.max(safeStartTime, parseInteger(endTime, safeStartTime));
        if (!safeStartTime || safeEndTime <= safeStartTime) return false;

        const dayDate = new Date(safeStartTime);
        const { weekKey, dayIdx } = getCurrentDayMeta(dayDate);
        const dayData = ensureWeekDay(weekKey, dayIdx);
        const nextEntry = normalizeStudySessionEntry({
            startTime: safeStartTime,
            endTime: safeEndTime,
            mode,
            type: "study"
        });
        const mergedSessions = mergeStudySessions(dayData.studySessions || [], [nextEntry]);
        if ((dayData.studySessions || []).length === mergedSessions.length) {
            return false;
        }

        dayData.studySessions = mergedSessions;
        scheduleData[weekKey][dayIdx] = ensureDayObject(dayData);
        return true;
    }

    function appendBreakSessionSegment(startTime, endTime, mode = timerState.mode) {
        const safeStartTime = Math.max(0, parseInteger(startTime, 0));
        const safeEndTime = Math.max(safeStartTime, parseInteger(endTime, safeStartTime));
        if (!safeStartTime || safeEndTime <= safeStartTime) return false;

        const dayDate = new Date(safeStartTime);
        const { weekKey, dayIdx } = getCurrentDayMeta(dayDate);
        const dayData = ensureWeekDay(weekKey, dayIdx);
        const nextEntry = normalizeStudySessionEntry({
            startTime: safeStartTime,
            endTime: safeEndTime,
            mode,
            type: "break"
        });
        const mergedSessions = mergeStudySessions(dayData.breakSessions || [], [nextEntry]);
        if ((dayData.breakSessions || []).length === mergedSessions.length) {
            return false;
        }

        dayData.breakSessions = mergedSessions;
        scheduleData[weekKey][dayIdx] = ensureDayObject(dayData);
        return true;
    }

    function ensureDayObject(day = {}) {
        const workedSeconds = Math.max(0, parseInteger(day.workedSeconds, 0));
        const breakSeconds = Math.max(0, parseInteger(day.breakSeconds, 0));
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
            breakSeconds,
            questions: normalizedQuestions,
            subjectQuestions: subjectQuestionTotal ? subjectQuestions : (normalizedQuestions ? createFallbackSubjectQuestionMap(day, normalizedQuestions) : {}),
            studySessions: normalizeStudySessions(day.studySessions || day.sessions || []),
            breakSessions: normalizeStudySessions(day.breakSessions || day.breaks || [])
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

    function sanitizeUsernameInput(value = "") {
        return String(value || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function normalizeUsernameLookup(value = "") {
        return sanitizeUsernameInput(value)
            .normalize("NFKC")
            .toLocaleLowerCase("tr-TR");
    }

    async function findUsernameConflicts(username = "", options = {}) {
        const normalizedUsername = normalizeUsernameLookup(username);
        const excludeUid = String(options.excludeUid || "").trim();

        if (!normalizedUsername) return [];

        const snapshot = await db.collection("users").get();
        return (snapshot.docs || []).filter(doc => {
            if (excludeUid && doc.id === excludeUid) return false;

            const data = doc.data() || {};
            const candidates = [
                data.normalizedUsername,
                data.username,
                data.name
            ];

            return candidates.some(candidate => normalizeUsernameLookup(candidate) === normalizedUsername);
        });
    }

    async function ensureUsernameAvailable(username = "", options = {}) {
        const cleanUsername = sanitizeUsernameInput(username);
        const normalizedUsername = normalizeUsernameLookup(cleanUsername);

        if (cleanUsername.length < 2) {
            const error = new Error("username-too-short");
            error.code = "username-too-short";
            throw error;
        }

        const conflicts = await findUsernameConflicts(cleanUsername, options);
        if (conflicts.length > 0) {
            const error = new Error("username-already-in-use");
            error.code = "username-already-in-use";
            throw error;
        }

        return {
            cleanUsername,
            normalizedUsername
        };
    }

    async function cleanupRejectedSignupUser(user = null) {
        if (!user) return;

        try {
            await user.delete();
        } catch (deleteError) {
            console.error("Cakisan kayit auth hesabi silinemedi:", deleteError);
        }

        try {
            await auth.signOut();
        } catch (signOutError) {
            console.error("Cakisan kayit sonrasi cikis yapilamadi:", signOutError);
        }
    }

    function createSignupPayload(username, email, accountCreatedAt) {
        const nowMs = Date.now();
        const cleanUsername = sanitizeUsernameInput(username);
        const normalizedUsername = normalizeUsernameLookup(cleanUsername);
        const adminProfile = typeof getAdminProfileMeta === "function"
            ? getAdminProfileMeta(cleanUsername, email)
            : {
                isAdmin: typeof isAdminIdentity === "function" ? isAdminIdentity(cleanUsername, email) : false,
                role: (typeof isAdminIdentity === "function" && isAdminIdentity(cleanUsername, email)) ? "admin" : "user",
                adminTitle: (typeof isAdminIdentity === "function" && isAdminIdentity(cleanUsername, email)) ? "Kurucu Admin" : ""
            };
        return {
            username: cleanUsername,
            normalizedUsername,
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
            name: cleanUsername,
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
        if (isBreakTimerMode(timerRecord?.mode)) return false;
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
            lastForcedCheckpointAtMs: Math.max(
                0,
                parseInteger(session.lastForcedCheckpointAtMs, parseInteger(session.startedAtMs, 0))
            ),
            sessionDateKey: getTimerSessionDateKey(session),
            updatedAtMs: Date.now(),
            ownerId: timerInstanceId,
            modalOpen,
            lastSeenAtMs,
            resumeLocked: !!session.resumeLocked
        };
    }

    function createCommitSourceSession(session = timerState.session) {
        if (!session) return null;
        return {
            ...serializeTimerSession(session),
            ownerId: session.ownerId || timerInstanceId
        };
    }

    function logTimerReset(reason = "", details = {}) {
        try {
            console.log("RESET TRIGGERED:", String(reason || "unknown"), details || {});
        } catch (error) {
            console.log("RESET TRIGGERED:", String(reason || "unknown"));
        }
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
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") {
                console.log("RESET TRIGGERED:", "invalid-stored-timer-session", { rawType: typeof parsed });
                return null;
            }
            return parsed;
        } catch (error) {
            console.error("Timer local verisi okunamadi:", error);
            return null;
        }
    }

    function readTimerFinalizedSnapshot() {
        try {
            const raw = localStorage.getItem(TIMER_FINALIZED_STORAGE_KEY);
            if (!raw) return null;

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return null;

            const uid = String(parsed.uid || "").trim();
            const dateKey = String(parsed.dateKey || "").trim();
            const elapsedSeconds = Math.max(0, parseInteger(parsed.elapsedSeconds, 0));
            if (!uid || !dateKey || elapsedSeconds <= 0) {
                return null;
            }

            return {
                uid,
                mode: normalizeTimerMode(parsed.mode),
                elapsedSeconds,
                targetDurationSeconds: Math.max(0, parseInteger(parsed.targetDurationSeconds, 0)),
                dateKey,
                savedAtMs: Math.max(0, parseInteger(parsed.savedAtMs, 0)),
                reason: String(parsed.reason || "").trim()
            };
        } catch (error) {
            console.error("Finalize timer verisi okunamadi:", error);
            return null;
        }
    }

    function clearTimerFinalizedSnapshot(expectedUid = currentUser?.uid || "") {
        const snapshot = readTimerFinalizedSnapshot();
        if (!snapshot) return false;
        if (expectedUid && snapshot.uid && snapshot.uid !== expectedUid) {
            return false;
        }
        try {
            localStorage.removeItem(TIMER_FINALIZED_STORAGE_KEY);
            return true;
        } catch (error) {
            console.error("Finalize timer verisi silinemedi:", error);
            return false;
        }
    }

    function persistTimerFinalizedSnapshot(session = timerState.session, referenceMs = Date.now(), options = {}) {
        if (!session) return false;
        const normalizedMode = normalizeTimerMode(options.mode || session.mode);
        if (isBreakTimerMode(normalizedMode) && options.allowBreak !== true) {
            return false;
        }

        const uid = String(
            options.uid
            || session.uid
            || currentUser?.uid
            || currentUserLiveDoc?.uid
            || ""
        ).trim();
        if (!uid) return false;

        const safeReferenceMs = Math.max(0, parseInteger(referenceMs, Date.now()));
        const elapsedSeconds = Math.max(
            0,
            parseInteger(options.elapsedSeconds, getTimerElapsedSeconds(session, safeReferenceMs))
        );
        if (elapsedSeconds <= 0) return false;

        const snapshot = {
            uid,
            mode: normalizedMode,
            elapsedSeconds,
            targetDurationSeconds: Math.max(
                0,
                parseInteger(options.targetDurationSeconds, parseInteger(session.targetDurationSeconds, 0))
            ),
            dateKey: String(
                options.dateKey
                || getTimerSessionDateKey(session, new Date(safeReferenceMs))
                || getCurrentDayMeta(new Date(safeReferenceMs)).dateKey
            ).trim(),
            savedAtMs: safeReferenceMs,
            reason: String(options.reason || "finalized").trim()
        };

        if (!snapshot.dateKey) return false;

        try {
            localStorage.setItem(TIMER_FINALIZED_STORAGE_KEY, JSON.stringify(snapshot));
            return true;
        } catch (error) {
            console.error("Finalize timer verisi saklanamadi:", error);
            return false;
        }
    }

    function buildStoppedTimerSessionFromFinalizedSnapshot(snapshot = null, referenceDate = new Date()) {
        if (!snapshot) return null;
        const todayDateKey = getCurrentDayMeta(referenceDate).dateKey;
        if (String(snapshot.dateKey || "").trim() !== todayDateKey) {
            return null;
        }

        return {
            mode: normalizeTimerMode(snapshot.mode),
            isRunning: false,
            baseElapsedSeconds: Math.max(0, parseInteger(snapshot.elapsedSeconds, 0)),
            lastPersistedElapsedSeconds: Math.max(0, parseInteger(snapshot.elapsedSeconds, 0)),
            targetDurationSeconds: Math.max(0, parseInteger(snapshot.targetDurationSeconds, 0)),
            startedAtMs: 0,
            lastForcedCheckpointAtMs: Math.max(0, parseInteger(snapshot.savedAtMs, 0)),
            sessionDateKey: todayDateKey,
            updatedAtMs: Math.max(0, parseInteger(snapshot.savedAtMs, Date.now())),
            lastSeenAtMs: Math.max(0, parseInteger(snapshot.savedAtMs, 0)),
            modalOpen: false,
            ownerId: timerInstanceId,
            resumeLocked: ["auto-finalize-inactive", "restore-frozen", "complete", "study-complete"].includes(String(snapshot.reason || "").trim())
        };
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

    function commitTimerSessionLocally(commitSourceSession = null, options = {}) {
        if (!commitSourceSession) {
            return {
                committedDeltaSeconds: 0,
                committedElapsedSeconds: 0,
                referenceMs: Math.max(0, parseInteger(options.referenceMs, Date.now()))
            };
        }

        const referenceMs = Math.max(0, parseInteger(options.referenceMs, Date.now()));
        const committedDeltaSeconds = applyPendingTimerDelta(commitSourceSession, referenceMs);
        const committedElapsedSeconds = Math.max(
            parseInteger(options.committedElapsedSeconds, 0),
            getTimerElapsedSeconds(commitSourceSession, referenceMs)
        );

        commitSourceSession.lastPersistedElapsedSeconds = Math.max(
            parseInteger(commitSourceSession.lastPersistedElapsedSeconds, 0),
            committedElapsedSeconds
        );

        if (timerState.session) {
            timerState.session.lastPersistedElapsedSeconds = Math.max(
                parseInteger(timerState.session.lastPersistedElapsedSeconds, 0),
                committedElapsedSeconds
            );
            timerDrafts[timerState.session.mode] = { ...timerState.session };
        }

        if (typeof refreshCurrentTotals === "function") {
            refreshCurrentTotals();
        }

        if (committedDeltaSeconds > 0 || options.persistRecovery === true) {
            persistTimerRecoverySnapshot();
        }

        return {
            committedDeltaSeconds,
            committedElapsedSeconds,
            referenceMs
        };
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
                const mergedBreakSeconds = Math.max(
                    parseInteger(localDay.breakSeconds, 0),
                    parseInteger(recoveredDay.breakSeconds, 0)
                );
                const mergedQuestions = Math.max(
                    parseInteger(localDay.questions, 0),
                    parseInteger(recoveredDay.questions, 0)
                );
                const mergedTasks = localDay.tasks?.length ? localDay.tasks : recoveredDay.tasks;
                const mergedSubjectQuestions = Object.keys(localDay.subjectQuestions || {}).length
                    ? localDay.subjectQuestions
                    : recoveredDay.subjectQuestions;
                const mergedStudySessions = mergeStudySessions(localDay.studySessions || [], recoveredDay.studySessions || []);
                const mergedBreakSessions = mergeStudySessions(localDay.breakSessions || [], recoveredDay.breakSessions || []);

                if (
                    mergedWorkedSeconds !== parseInteger(localDay.workedSeconds, 0)
                    || mergedBreakSeconds !== parseInteger(localDay.breakSeconds, 0)
                    || mergedQuestions !== parseInteger(localDay.questions, 0)
                    || mergedTasks !== localDay.tasks
                    || mergedSubjectQuestions !== localDay.subjectQuestions
                    || mergedStudySessions.length !== (localDay.studySessions || []).length
                    || mergedBreakSessions.length !== (localDay.breakSessions || []).length
                ) {
                    changed = true;
                }

                scheduleData[weekKey][dayIdx] = ensureDayObject({
                    ...recoveredDay,
                    ...localDay,
                    tasks: mergedTasks,
                    subjectQuestions: mergedSubjectQuestions,
                    workedSeconds: mergedWorkedSeconds,
                    breakSeconds: mergedBreakSeconds,
                    questions: mergedQuestions,
                    studySessions: mergedStudySessions,
                    breakSessions: mergedBreakSessions
                });
            });
        });

        if (changed && typeof refreshCurrentTotals === "function") {
            refreshCurrentTotals();
        }
        return changed;
    }

    function createEmptyTimerSession(mode = timerState.mode, referenceDate = new Date()) {
        const normalizedMode = normalizeTimerMode(mode);
        return {
            mode: normalizedMode,
            isRunning: false,
            baseElapsedSeconds: 0,
            lastPersistedElapsedSeconds: 0,
            targetDurationSeconds: isCountdownTimerMode(normalizedMode) ? getPomodoroSeedSeconds() : 0,
            startedAtMs: 0,
            lastForcedCheckpointAtMs: 0,
            sessionDateKey: getCurrentDayMeta(referenceDate).dateKey,
            modalOpen: false,
            lastSeenAtMs: 0,
            resumeLocked: false
        };
    }

    function getTimerForcedCheckpointAtMs(session = timerState.session, now = Date.now()) {
        if (!session) return 0;
        const explicitCheckpointAtMs = Math.max(0, parseInteger(session.lastForcedCheckpointAtMs, 0));
        if (explicitCheckpointAtMs > 0) return explicitCheckpointAtMs;
        return Math.max(0, parseInteger(session.startedAtMs, now));
    }

    function getTimerAutoStopAtMs(session = timerState.session, now = Date.now()) {
        if (!session?.isRunning) return 0;
        const startedAtMs = Math.max(0, parseInteger(session.startedAtMs, 0));
        if (!startedAtMs) return 0;
        // Auto-stop only applies to the uninterrupted active stretch.
        // If the user pauses manually and resumes later, the 3-hour window
        // restarts from the new start time instead of stacking across pauses.
        return startedAtMs + TIMER_AUTO_STOP_MS;
    }

    function captureRunningTimerCheckpoint(session = timerState.session, referenceMs = Date.now(), options = {}) {
        if (!session?.isRunning) return null;

        const safeReferenceMs = Math.max(0, parseInteger(referenceMs, Date.now()));
        // Checkpoint saves the elapsed delta into today's schedule without ending the session.
        const commitSourceSession = createCommitSourceSession(session);
        const commitState = commitTimerSessionLocally(commitSourceSession, {
            referenceMs: safeReferenceMs,
            persistRecovery: options.persistRecovery !== false
        });

        session.lastPersistedElapsedSeconds = Math.max(
            parseInteger(session.lastPersistedElapsedSeconds, 0),
            commitState.committedElapsedSeconds
        );

        if (options.bumpCheckpoint !== false) {
            session.lastForcedCheckpointAtMs = safeReferenceMs;
        }

        if (options.touchSeen === true) {
            session.lastSeenAtMs = safeReferenceMs;
        }

        if (options.modalOpen !== undefined) {
            session.modalOpen = !!options.modalOpen;
        }
        session.updatedAtMs = safeReferenceMs;

        timerDrafts[session.mode] = { ...session };
        persistTimerSessionLocally(session);
        updateLocalActiveTimerSnapshot(session);
        refreshLeaderboardOptimistically(session);

        return {
            session,
            commitSourceSession,
            commitState,
            referenceMs: safeReferenceMs
        };
    }

    function finalizeInactiveTimerSession(referenceMs = Date.now(), options = {}) {
        const session = timerState.session;
        if (!session?.isRunning) return null;

        const safeReferenceMs = Math.max(0, parseInteger(referenceMs, Date.now()));
        const commitSourceSession = createCommitSourceSession(session);
        const commitState = commitTimerSessionLocally(commitSourceSession, {
            referenceMs: safeReferenceMs,
            persistRecovery: true
        });
        const elapsed = commitState.committedElapsedSeconds;

        session.baseElapsedSeconds = elapsed;
        session.lastPersistedElapsedSeconds = elapsed;
        session.isRunning = false;
        session.startedAtMs = 0;
        session.modalOpen = false;
        session.lastSeenAtMs = safeReferenceMs;
        session.lastForcedCheckpointAtMs = Math.max(
            getTimerForcedCheckpointAtMs(session, safeReferenceMs),
            safeReferenceMs
        );
        session.sessionDateKey = getCurrentDayMeta(new Date(safeReferenceMs)).dateKey;
        session.updatedAtMs = safeReferenceMs;

        timerState.session = session;
        timerDrafts[session.mode] = { ...session };
        isRunning = false;
        stopTimerLoops();
        persistTimerSessionLocally(session);
        persistTimerFinalizedSnapshot(session, safeReferenceMs, {
            elapsedSeconds: elapsed,
            reason: String(options.syncReason || "auto-finalize-inactive")
        });
        updateLocalActiveTimerSnapshot(null);
        refreshLeaderboardOptimistically(null);
        renderTimerUi();
        releaseTimerOwnership();

        monitorTimerSyncPromise(syncRealtimeTimer(String(options.syncReason || "auto-finalize-inactive"), {
            activeSession: null,
            currentSessionTime: 0,
            clearActive: true,
            commitElapsed: true,
            commitSourceSession,
            committedElapsedSeconds: elapsed,
            userTriggeredWrite: true,
            authorized: true
        }), {
            label: "timer-auto-finalize",
            timeoutMessage: "",
            failureMessage: "",
            persistRecovery: true
        });

        if (options.showAlert !== false) {
            safeShowAlert("3 saat boyunca geri dönülmediği için süre otomatik kaydedildi ve durduruldu.", "info");
        }

        return {
            action: "auto-finalized",
            commitSourceSession,
            commitState,
            elapsed,
            referenceMs: safeReferenceMs
        };
    }

    function maybeRecoverInactiveTimerSession(now = Date.now(), options = {}) {
        const session = timerState.session;
        if (!session?.isRunning || timerState.transitioning || timerState.reconciling) {
            return { action: "none" };
        }

        const safeNow = Math.max(0, parseInteger(now, Date.now()));
        const autoStopAtMs = getTimerAutoStopAtMs(session, safeNow);
        if (!autoStopAtMs) {
            return { action: "none" };
        }
        timerState.reconciling = true;

        try {
            // A hidden/mobile session may wake up hours later; reconcile it before touching visibility state.
            if (safeNow >= autoStopAtMs) {
                return finalizeInactiveTimerSession(autoStopAtMs, {
                    syncReason: options.syncReason || "inactive-auto-stop",
                    showAlert: options.showAlert
                }) || { action: "none" };
            }

            const lastCheckpointAtMs = getTimerForcedCheckpointAtMs(session, safeNow);
            if (lastCheckpointAtMs && (safeNow - lastCheckpointAtMs) >= TIMER_FORCED_CHECKPOINT_MS) {
                const checkpointState = captureRunningTimerCheckpoint(session, safeNow, {
                    bumpCheckpoint: true,
                    modalOpen: options.modalOpen,
                    persistRecovery: true
                });

                if (checkpointState) {
                    renderTimerUi();
                    monitorTimerSyncPromise(syncRealtimeTimer(String(options.syncReason || "restore-hourly-checkpoint"), {
                        activeSession: session,
                        currentSessionTime: getPendingTimerDelta(session),
                        userTriggeredWrite: true,
                        authorized: true
                    }), {
                        label: "timer-recovery-checkpoint",
                        timeoutMessage: "",
                        failureMessage: "",
                        persistRecovery: true
                    });
                    return {
                        action: "checkpoint",
                        ...checkpointState
                    };
                }
            }

            return { action: "none" };
        } finally {
            timerState.reconciling = false;
        }
    }

    function maybeTriggerForcedHourlyCheckpoint(now = Date.now()) {
        const activeSession = timerState.session;
        if (!activeSession?.isRunning || timerState.transitioning || timerState.reconciling) return false;

        const lastCheckpointAtMs = getTimerForcedCheckpointAtMs(activeSession, now);
        if (!lastCheckpointAtMs || (now - lastCheckpointAtMs) < TIMER_FORCED_CHECKPOINT_MS) {
            return false;
        }

        const checkpointState = captureRunningTimerCheckpoint(activeSession, now, {
            bumpCheckpoint: true,
            modalOpen: isTimerModalOpen(),
            persistRecovery: true
        });
        if (!checkpointState) return false;

        renderTimerUi();
        monitorTimerSyncPromise(syncRealtimeTimer("hourly-checkpoint", {
            activeSession,
            currentSessionTime: getPendingTimerDelta(activeSession),
            userTriggeredWrite: true,
            authorized: true
        }), {
            label: "timer-hourly-checkpoint",
            timeoutMessage: "",
            failureMessage: ""
        });

        return true;
    }

    function getPomodoroInputSeconds() {
        const hours = clampNumber(document.getElementById("study-hours")?.value, 0, 9);
        const minutes = clampNumber(document.getElementById("study-minutes")?.value, 0, 59);
        const seconds = clampNumber(document.getElementById("study-seconds")?.value, 0, 59);
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    function resetTimerDurationInputs(totalSeconds = 0) {
        const safeSeconds = Math.max(0, parseInteger(totalSeconds, 0));
        const hours = document.getElementById("study-hours");
        const minutes = document.getElementById("study-minutes");
        const seconds = document.getElementById("study-seconds");
        if (hours) hours.value = Math.floor(safeSeconds / 3600);
        if (minutes) minutes.value = Math.floor((safeSeconds % 3600) / 60);
        if (seconds) seconds.value = safeSeconds % 60;
    }

    function getPomodoroSeedSeconds() {
        return Math.max(0, getPomodoroInputSeconds());
    }

    function getTimerElapsedSeconds(session = timerState.session, now = Date.now()) {
        if (!session) return 0;
        const baseElapsed = Math.max(0, parseInteger(session.baseElapsedSeconds, 0));
        const autoStopAtMs = getTimerAutoStopAtMs(session, now);
        const effectiveNow = autoStopAtMs > 0
            ? Math.min(now, autoStopAtMs)
            : now;
        if (!session.isRunning || !session.startedAtMs) {
            return baseElapsed;
        }
        const runtime = Math.max(0, Math.floor((effectiveNow - parseInteger(session.startedAtMs, effectiveNow)) / 1000));
        return baseElapsed + runtime;
    }

    function isTimerRecordRunning(timerRecord, now = Date.now()) {
        if (!timerRecord || !timerRecord.isRunning) return false;
        if (hasTimerSessionCrossedDayBoundary(timerRecord, new Date(now))) return false;
        const autoStopAtMs = getTimerAutoStopAtMs(timerRecord, now);
        if (autoStopAtMs > 0 && now >= autoStopAtMs) return false;
        return true;
    }

    function getTimerDisplaySeconds(session = timerState.session) {
        if (!session) return isCountdownTimerMode(timerState.mode) ? getPomodoroInputSeconds() : 0;
        if (hasTimerSessionCrossedDayBoundary(session)) {
            return isCountdownTimerMode(session.mode)
                ? Math.max(0, parseInteger(session.targetDurationSeconds, getPomodoroSeedSeconds()))
                : 0;
        }
        const elapsed = getTimerElapsedSeconds(session);
        if (isStopwatchTimerMode(session.mode)) return elapsed;
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
        const lockedResume = !!timerState.session?.resumeLocked;
        const running = !!timerState.session?.isRunning;
        const isStopwatch = isStopwatchTimerMode(timerState.mode);
        const isBreak = isBreakTimerMode(timerState.mode);

        if (running) {
            startPauseButton.innerHTML = '<i class="fas fa-pause"></i> Duraklat';
        } else if (hasProgress) {
            startPauseButton.innerHTML = lockedResume
                ? `<i class="fas fa-play"></i> ${isStopwatch ? (isBreak ? "Yeni Mola Baslat" : "Yeni Kronometre Baslat") : (isBreak ? "Yeni Mola Baslat" : "Yeni Pomodoro Baslat")}`
                : '<i class="fas fa-play"></i> Devam Et';
        } else {
            startPauseButton.innerHTML = `<i class="fas fa-play"></i> ${isStopwatch ? (isBreak ? "Mola Kronometresini Baslat" : "Kronometre Baslat") : (isBreak ? "Mola Zamanlayicisini Baslat" : "Pomodoro Baslat")}`;
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
        const modeLabel = getTimerModeLabel(timerState.mode);
        pill.innerHTML = `<i class="fas fa-wave-square"></i> ${modeLabel} - Otomatik kayit acik${unsynced > 0 ? ` - ${unsynced}s bekleyen senkron` : ""}`;
    }

    function renderTimerUi() {
        const content = document.querySelector("#pomodoro-modal .pomodoro-content");
        if (!content) return;

        if (timerState.session?.isRunning) {
            touchTimerVisibility(Date.now(), { modalOpen: isTimerModalOpen() });
        }

        content.classList.toggle("is-stopwatch-mode", isStopwatchTimerMode(timerState.mode));
        updateTimerButtons();
        updateTimerSessionPill();

        const titleNode = content.querySelector("h2");
        if (titleNode) {
            titleNode.textContent = getTimerContextTitle(timerState.mode);
        }

        const displaySeconds = getTimerDisplaySeconds();
        timeRemaining = displaySeconds;
        renderSegmentedTimer(displaySeconds);

        if (timerState.session?.isRunning) {
            updateTimerStatus(isBreakTimerMode(timerState.mode)
                ? (isStopwatchTimerMode(timerState.mode)
                    ? "Mola kronometresi calisiyor."
                    : "Mola geri sayimi calisiyor.")
                : (isStopwatchTimerMode(timerState.mode)
                    ? "Kronometre calisiyor."
                    : "Pomodoro calisiyor."));
        } else {
            updateTimerStatus("");
        }

        updateLiveStudyPreview();
    }

    async function maybeAutoStopHiddenTimer() {
        const recoveryState = maybeRecoverInactiveTimerSession(Date.now(), {
            syncReason: "auto-stop-hidden",
            showAlert: true,
            modalOpen: false
        });
        return recoveryState.action === "auto-finalized";
    }

    function playBreakFinishedAlert() {
        try {
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtor) return false;
            const audioContext = new AudioCtor();
            const masterGain = audioContext.createGain();
            const compressor = audioContext.createDynamicsCompressor();
            masterGain.gain.setValueAtTime(0.001, audioContext.currentTime);
            masterGain.gain.linearRampToValueAtTime(0.42, audioContext.currentTime + 0.04);
            masterGain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 1.6);
            masterGain.connect(compressor);
            compressor.connect(audioContext.destination);

            const chimeOffsets = [0, 0.32, 0.64];
            chimeOffsets.forEach((offset, index) => {
                const baseTime = audioContext.currentTime + offset;
                const mainOsc = audioContext.createOscillator();
                const overtoneOsc = audioContext.createOscillator();
                const toneGain = audioContext.createGain();

                mainOsc.type = "triangle";
                overtoneOsc.type = "sine";

                mainOsc.frequency.setValueAtTime(1318.51, baseTime);
                mainOsc.frequency.exponentialRampToValueAtTime(1046.5, baseTime + 0.34);
                overtoneOsc.frequency.setValueAtTime(1567.98, baseTime);
                overtoneOsc.frequency.exponentialRampToValueAtTime(1174.66, baseTime + 0.34);

                toneGain.gain.setValueAtTime(0.0001, baseTime);
                toneGain.gain.exponentialRampToValueAtTime(index === 0 ? 0.9 : 0.65, baseTime + 0.025);
                toneGain.gain.exponentialRampToValueAtTime(0.18, baseTime + 0.22);
                toneGain.gain.exponentialRampToValueAtTime(0.0001, baseTime + 0.52);

                mainOsc.connect(toneGain);
                overtoneOsc.connect(toneGain);
                toneGain.connect(masterGain);

                mainOsc.start(baseTime);
                overtoneOsc.start(baseTime);
                mainOsc.stop(baseTime + 0.54);
                overtoneOsc.stop(baseTime + 0.54);
            });

            setTimeout(() => {
                audioContext.close().catch(() => null);
            }, 1900);
            return true;
        } catch (error) {
            console.error("Mola sesi calinamadi:", error);
            return false;
        }
    }

    function ensureTimerModeUi() {
        const content = document.querySelector("#pomodoro-modal .pomodoro-content");
        const titleNode = content?.querySelector("h2");
        const inputGroup = content?.querySelector(".pomodoro-time-inputs");
        if (!content || !titleNode || !inputGroup) return;

        if (!document.getElementById("timer-track-toggle")) {
            const trackToggle = document.createElement("div");
            trackToggle.id = "timer-track-toggle";
            trackToggle.className = "timer-mode-toggle";
            trackToggle.innerHTML = `
                <button class="timer-mode-toggle__button" type="button" data-track="study">Çalışma</button>
                <button class="timer-mode-toggle__button" type="button" data-track="break">Mola</button>
            `;
            titleNode.insertAdjacentElement("afterend", trackToggle);

            trackToggle.querySelectorAll("[data-track]").forEach(button => {
                button.addEventListener("click", () => {
                    const nextTrack = button.dataset.track === "break" ? "break" : "study";
                    const nextMode = nextTrack === "break"
                        ? (isStopwatchTimerMode(timerState.mode) ? "break-stopwatch" : "break-pomodoro")
                        : (isStopwatchTimerMode(timerState.mode) ? "stopwatch" : "pomodoro");
                    setTimerMode(nextMode);
                });
            });
        }

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
        const normalizedMode = normalizeTimerMode(mode);

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

        document.querySelectorAll("#timer-track-toggle [data-track]").forEach(button => {
            button.classList.toggle("is-active", button.dataset.track === getTimerTrack(normalizedMode));
        });
        document.querySelectorAll("#timer-mode-toggle [data-mode]").forEach(button => {
            const buttonMode = button.dataset.mode === "stopwatch"
                ? (getTimerTrack(normalizedMode) === "break" ? "break-stopwatch" : "stopwatch")
                : (getTimerTrack(normalizedMode) === "break" ? "break-pomodoro" : "pomodoro");
            button.classList.toggle("is-active", buttonMode === normalizedMode);
            if (button.dataset.mode === "stopwatch") {
                button.textContent = "Kronometre";
            } else {
                button.textContent = getTimerTrack(normalizedMode) === "break" ? "Geri Sayım" : "Pomodoro";
            }
        });

        const note = document.getElementById("timer-mode-note");
        if (note) {
            note.innerHTML = normalizedMode === "stopwatch"
                ? "<strong>Kronometre</strong> 00:00:00'dan baslar ve ileri sayar. Durdurulmazsa 3 saat sonunda otomatik durur."
                : normalizedMode === "break-stopwatch"
                    ? "<strong>Mola kronometresi</strong> molayı ileri sayar. İstersen manuel kaydedip kapatabilirsin."
                    : normalizedMode === "break-pomodoro"
                        ? "<strong>Mola geri sayımı</strong> seçtiğin mola süresinden geri sayar; süre bitince sesli uyarı verir ve molayı kaydeder."
                        : "<strong>Pomodoro</strong> geri sayim yapar; sure 0 olsa da sen durdurana kadar calismayi surdurur. Acik kalan timer 3 saat sonunda otomatik durur.";
        }

        if (!options.keepSession) {
            const savedDraft = timerDrafts[normalizedMode];
            const freshDraft = hasTimerSessionCrossedDayBoundary(savedDraft) ? null : savedDraft;
            if (!timerState.session || timerState.session.mode !== normalizedMode || !timerState.session.isRunning) {
                if (savedDraft && !freshDraft) {
                    timerDrafts[normalizedMode] = buildFreshTimerSession(normalizedMode);
                }

                timerState.session = freshDraft
                    ? { ...freshDraft }
                    : createEmptyTimerSession(normalizedMode);

                if (isCountdownTimerMode(normalizedMode) && !freshDraft) {
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
            const recoveryState = maybeRecoverInactiveTimerSession(Date.now(), {
                syncReason: "interval-recovery",
                showAlert: false,
                modalOpen: isTimerModalOpen()
            });
            if (recoveryState.action === "auto-finalized") return;
            if (timerState.session?.isRunning && normalizeTimerMode(timerState.mode) === "break-pomodoro" && getTimerDisplaySeconds(timerState.session) <= 0) {
                completePomodoroSession().catch(error => {
                    console.error("Mola geri sayimi tamamlanamadi:", error);
                });
                return;
            }
            maybeTriggerForcedHourlyCheckpoint(Date.now());
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
                currentSessionTime: getPendingTimerDelta(timerState.session),
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

        const isBreakSession = isBreakTimerMode(session?.mode || timerState.mode);

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

            if (isBreakSession) {
                applyBreakDelta(segmentSeconds, cursorDate);
                appendBreakSessionSegment(cursorMs, cursorMs + (segmentSeconds * 1000), session?.mode || timerState.mode);
            } else {
                applyStudyDelta(segmentSeconds, cursorDate);
                appendStudySessionSegment(cursorMs, cursorMs + (segmentSeconds * 1000), session?.mode || timerState.mode);
            }
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
                id: "as1",
                minAvgHours: 10,
                label: "AS I",
                icon: "⚔",
                className: "title-as-1",
                description: "2 günlük 10 saatlik ortalama artık normal tempo değil, savaş temposu. Çoğu kişinin dağıldığı yerde sen masayı ele geçiriyor, iradeni her oturuşta kanıtlıyorsun."
            },
            {
                id: "as2",
                minAvgHours: 11,
                label: "AS II",
                icon: "⚡",
                className: "title-as-2",
                description: "11 saatlik ortalama, iradenin gösteri yaptığı seviye. Yorulmak seni yavaşlatmıyor; daha keskin, daha saldırgan ve daha kararlı hale getiriyor."
            },
            {
                id: "fatih",
                minAvgHours: 12,
                label: "Fatih",
                icon: "👑",
                className: "title-fatih",
                description: "En üst mertebe. 12 saatlik 2 günlük ortalama ile artık hedef kovalamıyorsun; hedefi kuşatıp fethediyorsun. Fatih ünvanı, masaya hükmeden ve çevresindeki herkesi gaza getiren çalışma iradesinin simgesidir."
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
            .title-badge.title-as-1,
            .title-badge.title-as-2,
            .title-badge.title-fatih {
                border-width: 1px;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 10px 22px rgba(15, 23, 42, 0.18);
            }
            .title-badge {
                position: relative;
                overflow: hidden;
                isolation: isolate;
                transition: transform 0.28s ease, box-shadow 0.32s ease, filter 0.32s ease;
            }
            .title-badge > span {
                position: relative;
                z-index: 1;
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
            .title-badge.title-as-1,
            .title-badge.title-as-2,
            .title-badge.title-fatih {
                text-shadow: 0 0 12px rgba(255,255,255,0.18);
            }
            .title-badge.title-as-1::after,
            .title-badge.title-as-2::after,
            .title-badge.title-fatih::after {
                content: "";
                position: absolute;
                top: -120%;
                left: -24%;
                width: 42%;
                height: 260%;
                background: linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.04) 20%, rgba(255,255,255,0.72) 50%, rgba(255,255,255,0.05) 80%, transparent 100%);
                transform: rotate(22deg);
                animation: codexTitleShine 3.6s linear infinite;
                opacity: 0.74;
                pointer-events: none;
                z-index: 0;
            }
            .title-badge.title-as-1 {
                background: linear-gradient(135deg, rgba(127, 29, 29, 0.92), rgba(220, 38, 38, 0.78), rgba(248, 113, 113, 0.34));
                color: #ffe4e6;
                border-color: rgba(254, 202, 202, 0.44);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 1px rgba(127, 29, 29, 0.32), 0 14px 26px rgba(153, 27, 27, 0.22), 0 0 18px rgba(248, 113, 113, 0.16);
                animation: codexAsPulse 3.8s ease-in-out infinite;
            }
            .title-badge.title-as-2 {
                background: linear-gradient(135deg, rgba(127, 29, 29, 0.96), rgba(239, 68, 68, 0.84), rgba(251, 146, 60, 0.44));
                color: #fff1f2;
                border-color: rgba(255, 228, 230, 0.52);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 0 0 1px rgba(153, 27, 27, 0.34), 0 16px 28px rgba(185, 28, 28, 0.24), 0 0 22px rgba(248, 113, 113, 0.22);
                animation: codexAsPulseStrong 3.2s ease-in-out infinite;
            }
            .title-badge.title-fatih {
                padding: 7px 14px;
                font-size: 0.9em;
                letter-spacing: 0.55px;
                background: linear-gradient(135deg, rgba(255, 244, 179, 0.96), rgba(255, 215, 0, 0.86), rgba(245, 158, 11, 0.82), rgba(255, 232, 153, 0.92));
                color: #4a2a00;
                border-color: rgba(255, 243, 176, 0.92);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(255, 215, 0, 0.34), 0 18px 34px rgba(217, 119, 6, 0.28), 0 0 30px rgba(255, 215, 0, 0.36);
                filter: saturate(1.08);
                animation: codexFatihPulse 2.5s ease-in-out infinite;
            }
            .title-badge.small.title-as-1,
            .title-badge.small.title-as-2 {
                font-size: 0.71em;
                min-height: 26px;
            }
            .title-badge.small.title-fatih {
                padding: 4px 10px;
                font-size: 0.76em;
                min-height: 28px;
            }
            @keyframes codexTitleShine {
                0% { transform: translateX(-165%) rotate(22deg); opacity: 0; }
                18% { opacity: 0.7; }
                46% { opacity: 0.88; }
                72% { opacity: 0.18; }
                100% { transform: translateX(305%) rotate(22deg); opacity: 0; }
            }
            @keyframes codexAsPulse {
                0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 1px rgba(127, 29, 29, 0.32), 0 14px 26px rgba(153, 27, 27, 0.22), 0 0 16px rgba(248, 113, 113, 0.14); transform: translateY(0); }
                50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 0 0 1px rgba(127, 29, 29, 0.38), 0 16px 30px rgba(185, 28, 28, 0.28), 0 0 24px rgba(248, 113, 113, 0.22); transform: translateY(-1px); }
            }
            @keyframes codexAsPulseStrong {
                0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 0 0 1px rgba(153, 27, 27, 0.34), 0 16px 28px rgba(185, 28, 28, 0.24), 0 0 20px rgba(248, 113, 113, 0.2); transform: translateY(0) scale(1); }
                50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 1px rgba(185, 28, 28, 0.42), 0 18px 32px rgba(185, 28, 28, 0.3), 0 0 28px rgba(251, 146, 60, 0.24); transform: translateY(-1px) scale(1.01); }
            }
            @keyframes codexFatihPulse {
                0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(255, 215, 0, 0.34), 0 18px 34px rgba(217, 119, 6, 0.28), 0 0 28px rgba(255, 215, 0, 0.32); transform: translateY(0) scale(1); }
                50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.5), 0 0 0 1px rgba(255, 240, 180, 0.48), 0 22px 38px rgba(217, 119, 6, 0.34), 0 0 40px rgba(255, 215, 0, 0.48); transform: translateY(-1px) scale(1.02); }
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

    function getCurrentDayWorkedSecondsFromSchedule(schedule, referenceDate = new Date(), displayReferenceMs = Date.now()) {
        const { weekKey, dayIdx } = getCurrentDayMeta(referenceDate);
        const dayData = ensureDayObject(schedule?.[weekKey]?.[dayIdx] || {});
        return clampWorkedSecondsForDisplay(dayData.workedSeconds, referenceDate, displayReferenceMs);
    }

    function getCurrentDayBreakSecondsFromSchedule(schedule, referenceDate = new Date()) {
        const { weekKey, dayIdx } = getCurrentDayMeta(referenceDate);
        const dayData = ensureDayObject(schedule?.[weekKey]?.[dayIdx] || {});
        return Math.max(0, parseInteger(dayData.breakSeconds, 0));
    }

    function getCurrentWeekWorkedSecondsFromSchedule(schedule, referenceDate = new Date()) {
        const { weekKey } = getCurrentDayMeta(referenceDate);
        const weekData = schedule?.[weekKey] || {};
        let seconds = 0;

        for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
            seconds += Math.max(0, parseInteger(weekData?.[dayIdx]?.workedSeconds, 0));
        }

        return seconds;
    }

    function getAdminWeeklyAdjustmentTarget(userData = {}, referenceDate = new Date()) {
        const adjustment = normalizeAdminTimeAdjustment(userData?.adminTimeAdjustment);
        if (!adjustment || adjustment.scope !== "week") return null;

        const { weekKey } = getCurrentDayMeta(referenceDate);
        if (adjustment.weekKey && adjustment.weekKey !== weekKey) return null;

        return Math.max(
            0,
            parseInteger(adjustment.appliedWeekSeconds, 0),
            parseInteger(adjustment.targetSeconds, 0)
        );
    }

    function getResolvedCurrentWeekWorkedSeconds(userData = {}, schedule = {}, referenceDate = new Date()) {
        const scheduleWeeklySeconds = getCurrentWeekWorkedSecondsFromSchedule(schedule, referenceDate);
        const adminWeeklyTarget = getAdminWeeklyAdjustmentTarget(userData, referenceDate);
        if (adminWeeklyTarget !== null) return adminWeeklyTarget;

        return Math.max(
            scheduleWeeklySeconds,
            parseInteger(userData?.weeklyStudyTime, 0),
            parseInteger(userData?.currentWeekSeconds, 0)
        );
    }

    function getCurrentWeekBreakSecondsFromSchedule(schedule, referenceDate = new Date()) {
        const { weekKey } = getCurrentDayMeta(referenceDate);
        const weekData = schedule?.[weekKey] || {};
        let seconds = 0;

        for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
            seconds += Math.max(0, parseInteger(weekData?.[dayIdx]?.breakSeconds, 0));
        }

        return seconds;
    }

    function getLeaderboardDayDisplayReferenceMs(userData = {}, referenceDate = new Date(), now = Date.now()) {
        const safeNow = Math.max(0, parseInteger(now, Date.now()));
        const dayStart = new Date(referenceDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayStartMs = dayStart.getTime();
        const hasVisibleActiveTimer = isTimerVisibleForLeaderboard(userData?.activeTimer, safeNow);
        const liveSessionSnapshot = getLeaderboardLiveSessionSnapshot(userData || {}, safeNow);

        if (hasVisibleActiveTimer || liveSessionSnapshot.isLive) {
            return safeNow;
        }

        const lastSyncAt = getLeaderboardSessionLastSyncAt(userData || {});
        if (lastSyncAt <= 0) {
            return dayStartMs;
        }

        return Math.max(dayStartMs, Math.min(safeNow, lastSyncAt));
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
        const displayReferenceMs = getLeaderboardDayDisplayReferenceMs(safeData, referenceDate, referenceDate.getTime());
        const explicitDateKey = String(
            safeData?.dailyStudyDateKey
            || safeData?.todayDateKey
            || ""
        ).trim();
        const safeSchedule = sanitizeScheduleData(safeData.schedule || {});
        const scheduleSeconds = getCurrentDayWorkedSecondsFromSchedule(safeSchedule, referenceDate, displayReferenceMs);
        const explicitDailySeconds = Math.max(
            parseInteger(safeData?.dailyStudyTime, 0),
            parseInteger(safeData?.todayStudyTime, 0),
            parseInteger(safeData?.todayWorkedSeconds, 0)
        );
        const maxPossibleDailySeconds = clampWorkedSecondsForDisplay(86400, referenceDate, displayReferenceMs);
        const hasVisibleActiveTimer = isTimerVisibleForLeaderboard(safeData?.activeTimer, referenceDate.getTime());
        const liveSessionSnapshot = getLeaderboardLiveSessionSnapshot(safeData, referenceDate.getTime());
        const hasVisibleLiveSession = hasVisibleActiveTimer || liveSessionSnapshot.isLive;
        const isFreshSnapshot = isDailyStudySnapshotFresh(safeData, referenceDate);
        const hasImpossibleDailyOverflow = explicitDailySeconds > maxPossibleDailySeconds;
        const shouldReset = !hasVisibleLiveSession && (
            !isFreshSnapshot
            || (!explicitDateKey && explicitDailySeconds > scheduleSeconds && scheduleSeconds <= 0)
            || hasImpossibleDailyOverflow
        );

        if (!shouldReset) {
            return {
                normalizedData: safeData,
                needsSync: false
            };
        }

        const normalizedDailySeconds = scheduleSeconds;
        const normalizedSchedule = sanitizeScheduleData(safeSchedule);
        const currentDayData = ensureDayObject(normalizedSchedule?.[currentMeta.weekKey]?.[currentMeta.dayIdx] || {});
        if (parseInteger(currentDayData.workedSeconds, 0) !== normalizedDailySeconds) {
            if (!normalizedSchedule[currentMeta.weekKey]) normalizedSchedule[currentMeta.weekKey] = {};
            normalizedSchedule[currentMeta.weekKey][currentMeta.dayIdx] = ensureDayObject({
                ...currentDayData,
                workedSeconds: normalizedDailySeconds
            });
        }
        const normalizedData = {
            ...safeData,
            schedule: normalizedSchedule,
            dailyStudyTime: normalizedDailySeconds,
            todayStudyTime: normalizedDailySeconds,
            todayWorkedSeconds: normalizedDailySeconds,
            currentSessionTime: 0,
            currentBreakSessionTime: 0,
            activeTimer: null,
            activeBreakTimer: null,
            legacyWorkingStartedAt: 0,
            isWorking: false,
            isRunning: false,
            isOnBreak: false,
            dailyStudyDateKey: currentMeta.dateKey,
            todayDateKey: currentMeta.dateKey
        };
        const needsSync = (
            parseInteger(safeData?.dailyStudyTime, 0) !== normalizedDailySeconds
            || parseInteger(safeData?.todayStudyTime, 0) !== normalizedDailySeconds
            || parseInteger(safeData?.todayWorkedSeconds, 0) !== normalizedDailySeconds
            || parseInteger(safeData?.currentSessionTime, 0) !== 0
            || parseInteger(safeData?.currentBreakSessionTime, 0) !== 0
            || !!safeData?.activeTimer
            || !!safeData?.activeBreakTimer
            || parseInteger(safeData?.legacyWorkingStartedAt, 0) > 0
            || !!safeData?.isWorking
            || !!safeData?.isRunning
            || !!safeData?.isOnBreak
            || parseInteger(safeSchedule?.[currentMeta.weekKey]?.[currentMeta.dayIdx]?.workedSeconds, 0) !== normalizedDailySeconds
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

    function getFreshDailyStudySeconds(userData = {}, schedule = {}, referenceDate = new Date(), options = {}) {
        const safeReferenceMs = Math.max(0, parseInteger(options?.displayReferenceMs, Date.now()));
        const resetState = getDailySnapshotResetState({
            ...(userData || {}),
            schedule: sanitizeScheduleData(schedule || userData?.schedule || {})
        }, referenceDate);
        // Daily truth must come from the per-day schedule entry only.
        // Mirrored fields are kept for compatibility, but they should never
        // resurrect yesterday's value into a fresh day.
        return getCurrentDayWorkedSecondsFromSchedule(
            resetState.normalizedData.schedule || {},
            referenceDate,
            safeReferenceMs
        );
    }

    function getFirstNonEmptyArray(...sources) {
        for (const source of sources) {
            if (Array.isArray(source) && source.length) return [...source];
        }
        return [];
    }

    function isWeakProfileIdentityValue(value = "", email = "") {
        const resolvedValue = String(value || "").trim();
        if (!resolvedValue) return true;

        const normalizedValue = resolvedValue.toLocaleLowerCase("tr-TR");
        if (normalizedValue === "kullanici" || normalizedValue === "kullanıcı") {
            return true;
        }

        const emailLocalPart = String(email || "")
            .split("@")[0]
            .trim()
            .toLocaleLowerCase("tr-TR");

        return !!emailLocalPart && normalizedValue === emailLocalPart;
    }

    function pickPreferredProfileText(candidates = [], options = {}) {
        const safeCandidates = Array.isArray(candidates) ? candidates : [candidates];
        const email = String(options?.email || "").trim();
        const allowWeak = options?.allowWeak === true;
        let fallback = "";

        for (const candidate of safeCandidates) {
            const resolvedValue = String(candidate || "").trim();
            if (!resolvedValue) continue;
            if (!fallback) fallback = resolvedValue;
            if (allowWeak || !isWeakProfileIdentityValue(resolvedValue, email)) {
                return resolvedValue;
            }
        }

        return fallback;
    }

    function getCurrentRuntimeProfileSeed() {
        return {
            uid: currentUser?.uid || "",
            username: currentUsername || "",
            email: currentUser?.email || "",
            about: currentProfileAbout || "",
            profileImage: currentProfileImage || "",
            accountCreatedAt: currentAccountCreatedAt || "",
            studyTrack: studyTrack || "",
            selectedSubjects: Array.isArray(selectedSubjects) ? [...selectedSubjects] : [],
            schedule: sanitizeScheduleData(scheduleData || {}),
            totalWorkedSeconds: totalWorkedSecondsAllTime || 0,
            totalStudyTime: totalWorkedSecondsAllTime || 0,
            totalQuestionsAllTime: totalQuestionsAllTime || 0,
            notes: normalizeUserNotes(userNotes || []),
            noteFolders: normalizeNoteFolders(noteFolders || [])
        };
    }

    function canWriteCurrentUserProfileSafely() {
        if (!currentUser?.uid) return false;
        if (!hasBootstrappedUsersRealtime) return false;
        return !currentUserHasRemoteProfile || currentUserProfileHydrated;
    }

    function resolveWritableCurrentUserProfile(basePayload = {}, options = {}) {
        const mergedProfile = mergeCurrentUserProfileSources(
            currentUserLiveDoc || {},
            currentUserPublicProfileDoc || {},
            getCurrentRuntimeProfileSeed(),
            basePayload || {}
        );
        const resolvedEmail = pickPreferredProfileText(
            [currentUser?.email, mergedProfile.email, basePayload.email],
            { allowWeak: true }
        );
        const allowWeakFallback = options.allowWeakFallback === true || !currentUserHasRemoteProfile;
        const resolvedUsername = pickPreferredProfileText(
            [
                mergedProfile.username,
                mergedProfile.name,
                basePayload.username,
                basePayload.name,
                currentUsername,
                currentUser?.displayName
            ],
            { email: resolvedEmail }
        ) || (allowWeakFallback ? (resolvedEmail?.split?.("@")?.[0] || "") : "");
        const resolvedStudyTrack = pickPreferredProfileText(
            [mergedProfile.studyTrack, basePayload.studyTrack, studyTrack],
            { allowWeak: true }
        );
        const resolvedSelectedSubjects = typeof normalizeSelectedSubjects === "function"
            ? normalizeSelectedSubjects(
                resolvedStudyTrack || "",
                getFirstNonEmptyArray(
                    mergedProfile.selectedSubjects,
                    basePayload.selectedSubjects,
                    selectedSubjects
                )
            )
            : getFirstNonEmptyArray(
                mergedProfile.selectedSubjects,
                basePayload.selectedSubjects,
                selectedSubjects
            );
        return {
            mergedProfile,
            email: String(resolvedEmail || "").trim(),
            username: String(resolvedUsername || "").trim(),
            about: pickPreferredProfileText(
                [currentProfileAbout, mergedProfile.about, basePayload.about],
                { allowWeak: true }
            ),
            profileImage: pickPreferredProfileText(
                [currentProfileImage, mergedProfile.profileImage, basePayload.profileImage],
                { allowWeak: true }
            ),
            accountCreatedAt: pickPreferredProfileText(
                [currentAccountCreatedAt, mergedProfile.accountCreatedAt, basePayload.accountCreatedAt],
                { allowWeak: true }
            ),
            studyTrack: String(resolvedStudyTrack || "").trim(),
            selectedSubjects: resolvedSelectedSubjects
        };
    }

    function mergeCurrentUserProfileSources(...sources) {
        const safeSources = sources
            .filter(source => source && typeof source === "object")
            .map(source => ({ ...source }));

        const resolvedEmail = pickPreferredProfileText(
            safeSources.map(source => source.email),
            { allowWeak: true }
        );
        const resolvedUsername = pickPreferredProfileText(
            safeSources.flatMap(source => [source.username, source.name]),
            { email: resolvedEmail }
        );
        const resolvedStudyTrack = pickPreferredProfileText(
            safeSources.map(source => source.studyTrack),
            { allowWeak: true }
        );
        const resolvedSelectedSubjects = typeof normalizeSelectedSubjects === "function"
            ? normalizeSelectedSubjects(
                resolvedStudyTrack,
                getFirstNonEmptyArray(...safeSources.map(source => source.selectedSubjects))
            )
            : getFirstNonEmptyArray(...safeSources.map(source => source.selectedSubjects));
        const resolvedSchedule = getMostInformativeProfileSchedule(
            ...safeSources.map(source => source.schedule)
        );
        const resolvedProfileImage = pickPreferredProfileText(
            safeSources.map(source => source.profileImage),
            { allowWeak: true }
        );
        const resolvedAbout = pickPreferredProfileText(
            safeSources.map(source => source.about),
            { allowWeak: true }
        );
        const resolvedAccountCreatedAt = pickPreferredProfileText(
            safeSources.map(source => source.accountCreatedAt),
            { allowWeak: true }
        );
        const resolvedNotes = typeof normalizeUserNotes === "function"
            ? normalizeUserNotes(getFirstNonEmptyArray(...safeSources.map(source => source.notes)))
            : getFirstNonEmptyArray(...safeSources.map(source => source.notes));
        const resolvedNoteFolders = typeof normalizeNoteFolders === "function"
            ? normalizeNoteFolders(getFirstNonEmptyArray(...safeSources.map(source => source.noteFolders)))
            : getFirstNonEmptyArray(...safeSources.map(source => source.noteFolders));
        const resolvedTotalWorkedSeconds = Math.max(
            ...safeSources.map(source => Math.max(
                parseInteger(source.totalWorkedSeconds, 0),
                parseInteger(source.totalStudyTime, 0)
            )),
            typeof calculateTotalWorkedSecondsFromSchedule === "function"
                ? calculateTotalWorkedSecondsFromSchedule(resolvedSchedule)
                : 0
        );
        const resolvedTotalQuestionsAllTime = Math.max(
            ...safeSources.map(source => parseInteger(source.totalQuestionsAllTime, 0)),
            typeof calculateTotalQuestionsFromSchedule === "function"
                ? calculateTotalQuestionsFromSchedule(resolvedSchedule)
                : 0
        );

        return {
            ...safeSources.reduce((accumulator, source) => ({ ...accumulator, ...source }), {}),
            uid: pickPreferredProfileText(safeSources.map(source => source.uid), { allowWeak: true }) || currentUser?.uid || "",
            email: resolvedEmail,
            username: resolvedUsername || "",
            name: pickPreferredProfileText(
                safeSources.flatMap(source => [source.name, source.username, resolvedUsername]),
                { email: resolvedEmail, allowWeak: true }
            ) || resolvedUsername || "",
            about: resolvedAbout,
            profileImage: resolvedProfileImage,
            accountCreatedAt: resolvedAccountCreatedAt,
            studyTrack: resolvedStudyTrack,
            selectedSubjects: resolvedSelectedSubjects,
            schedule: resolvedSchedule,
            totalWorkedSeconds: resolvedTotalWorkedSeconds,
            totalStudyTime: resolvedTotalWorkedSeconds,
            totalQuestionsAllTime: resolvedTotalQuestionsAllTime,
            notes: resolvedNotes,
            noteFolders: resolvedNoteFolders
        };
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
        // Weekly profile questions must come from the current Monday-Sunday schedule window.
        // Legacy mirrored weekly fields can leak last week's total into Monday, so do not trust
        // them here; only fall back to today's solved count if the current week schedule has not
        // been hydrated yet.
        const weeklyQuestions = Math.max(
            getCurrentWeekQuestionsFromSchedule(safeSchedule, referenceDate),
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
        const currentWeekSeconds = editable
            ? Math.max(
                getCurrentWeekWorkedSecondsFromSchedule(resolvedSchedule, referenceDate),
                getCurrentWeekWorkedSecondsFromSchedule(scheduleData || {}, referenceDate)
            )
            : getCurrentWeekWorkedSecondsFromSchedule(resolvedSchedule, referenceDate);
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
                activeTimer: isTimerVisibleForLeaderboard(timerState.session) ? serializeTimerSession(timerState.session) : null,
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
            activeTimer: isTimerVisibleForLeaderboard(timerState.session) ? serializeTimerSession(timerState.session) : null
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
        const safeProfile = resolveWritableCurrentUserProfile(basePayload);
        const safeSchedule = sanitizeScheduleData(
            getMostInformativeProfileSchedule(
                scheduleData || {},
                basePayload.schedule || {},
                safeProfile.mergedProfile?.schedule || {},
                currentUserLiveDoc?.schedule || {},
                currentUserPublicProfileDoc?.schedule || {}
            )
        );
        const currentDayMeta = getCurrentDayMeta(new Date());
        const questionCounters = buildQuestionCounterPayload(safeSchedule);
        const resolvedSelectedTitleId = getStoredSelectedTitleId(basePayload, currentUserLiveDoc || {});
        const resolvedTitleAwards = getStoredTitleAwards(basePayload, currentUserLiveDoc || {});
        const dailyStudyTime = getFreshDailyStudySeconds(basePayload, safeSchedule);
        const weeklyStudyTime = getCurrentWeekWorkedSecondsFromSchedule(safeSchedule);
        const activeTimer = basePayload.activeTimer || (timerState.session ? serializeTimerSession(timerState.session) : null);
        const activeTimerElapsedSeconds = activeTimer
            ? Math.max(0, getTimerElapsedSeconds(activeTimer))
            : 0;
        const legacyWorkingStartedAt = Math.max(
            parseInteger(basePayload.legacyWorkingStartedAt, 0),
            activeTimer
                ? Math.max(
                    parseInteger(activeTimer.startedAtMs, 0),
                    Date.now() - (activeTimerElapsedSeconds * 1000)
                )
                : 0
        );
        const publicNotes = typeof getPublicUserNotes === "function"
            ? getPublicUserNotes(basePayload.notes || userNotes || [])
            : [];
        const resolvedTitleInfo = buildResolvedTitleInfo({
            uid: currentUser?.uid || basePayload.uid || "",
            schedule: safeSchedule,
            activeTimer,
            selectedTitleId: resolvedSelectedTitleId,
            titleAwards: resolvedTitleAwards
        });

        return {
            uid: currentUser?.uid || basePayload.uid || "",
            username: safeProfile.username || "Kullanici",
            about: safeProfile.about || "",
            profileImage: safeProfile.profileImage || "",
            accountCreatedAt: safeProfile.accountCreatedAt || "",
            studyTrack: safeProfile.studyTrack || "",
            selectedSubjects: typeof normalizeSelectedSubjects === "function"
                ? normalizeSelectedSubjects(safeProfile.studyTrack || "", safeProfile.selectedSubjects || [])
                : (safeProfile.selectedSubjects || []),
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
            dailyStudyTime,
            todayStudyTime: dailyStudyTime,
            todayWorkedSeconds: dailyStudyTime,
            dailyStudyDateKey: currentDayMeta.dateKey,
            todayDateKey: currentDayMeta.dateKey,
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
        const safeProfile = isCurrentUserTarget
            ? resolveWritableCurrentUserProfile(basePayload)
            : {
                mergedProfile: basePayload || {},
                email: String(basePayload.email || "").trim(),
                username: String(basePayload.username || basePayload.name || "").trim(),
                about: String(basePayload.about || "").trim(),
                profileImage: String(basePayload.profileImage || "").trim(),
                accountCreatedAt: String(basePayload.accountCreatedAt || "").trim(),
                studyTrack: String(basePayload.studyTrack || "").trim(),
                selectedSubjects: Array.isArray(basePayload.selectedSubjects) ? [...basePayload.selectedSubjects] : []
            };
        const safeSchedule = sanitizeScheduleData(
            getMostInformativeProfileSchedule(
                isCurrentUserTarget ? (scheduleData || {}) : {},
                basePayload.schedule || {},
                safeProfile.mergedProfile?.schedule || {},
                currentUserLiveDoc?.schedule || {},
                currentUserPublicProfileDoc?.schedule || {}
            )
        );
        const currentDayMeta = getCurrentDayMeta(new Date());
        const questionCounters = buildQuestionCounterPayload(safeSchedule);
        const resolvedSelectedTitleId = getStoredSelectedTitleId(basePayload, isCurrentUserTarget ? (currentUserLiveDoc || {}) : {});
        const resolvedTitleAwards = getStoredTitleAwards(basePayload, isCurrentUserTarget ? (currentUserLiveDoc || {}) : {});
        const resolvedEmail = safeProfile.email || "";
        const resolvedUsername = safeProfile.username || "";
        const resolvedStudyTrack = safeProfile.studyTrack || "";
        const resolvedSelectedSubjectsSource = isCurrentUserTarget && Array.isArray(selectedSubjects) && selectedSubjects.length
            ? safeProfile.selectedSubjects
            : ((safeProfile.selectedSubjects && safeProfile.selectedSubjects.length) ? safeProfile.selectedSubjects : (basePayload.selectedSubjects || []));
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
        const dailyStudyTime = getFreshDailyStudySeconds(basePayload, safeSchedule);
        const weeklyStudyTime = getCurrentWeekWorkedSecondsFromSchedule(safeSchedule);
        const activeTimer = basePayload.activeTimer || (isCurrentUserTarget && timerState.session ? serializeTimerSession(timerState.session) : null);
        const currentSessionTime = Math.max(
            parseInteger(basePayload.currentSessionTime, 0),
            isCurrentUserTarget && isTimerVisibleForLeaderboard(timerState.session) ? getPendingTimerDelta(timerState.session) : 0
        );
        const activeTimerElapsedSeconds = activeTimer
            ? Math.max(0, getTimerElapsedSeconds(activeTimer))
            : 0;
        const legacyWorkingStartedAt = Math.max(
            parseInteger(basePayload.legacyWorkingStartedAt, 0),
            activeTimer
                ? Math.max(
                    parseInteger(activeTimer.startedAtMs, 0),
                    Date.now() - (activeTimerElapsedSeconds * 1000)
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
            about: safeProfile.about || "",
            profileImage: safeProfile.profileImage || "",
            accountCreatedAt: safeProfile.accountCreatedAt || "",
            studyTrack: resolvedStudyTrack,
            selectedSubjects: resolvedSelectedSubjects,
            selectedTitleId: resolvedTitleInfo.selectedTitleId,
            titleAwards: resolvedTitleInfo.titleAwards,
            dailyStudyTime,
            todayStudyTime: dailyStudyTime,
            todayWorkedSeconds: dailyStudyTime,
            dailyStudyDateKey: currentDayMeta.dateKey,
            todayDateKey: currentDayMeta.dateKey,
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
            || normalizedReason === "modal-hide";
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
        const safeProfile = resolveWritableCurrentUserProfile();

        const dailyQuestions = getCurrentDayQuestionsFromSchedule(scheduleData);
        const weeklyQuestions = getCurrentWeekQuestionsFromSchedule(scheduleData);
        const resolvedUsername = String(safeProfile.username || "").trim();

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

    function applyBreakDelta(deltaSeconds, date = new Date()) {
        if (!deltaSeconds) return;
        const { weekKey, dayIdx } = getCurrentDayMeta(date);
        const dayData = ensureWeekDay(weekKey, dayIdx);
        dayData.breakSeconds = Math.max(0, parseInteger(dayData.breakSeconds, 0) + deltaSeconds);
        scheduleData[weekKey][dayIdx] = ensureDayObject(dayData);
        refreshCurrentTotals();
    }

    function getCurrentDayWorkedSeconds(date = new Date()) {
        const { weekKey, dayIdx } = getCurrentDayMeta(date);
        const dayData = scheduleData?.[weekKey]?.[dayIdx];
        return dayData ? (ensureDayObject(dayData).workedSeconds || 0) : 0;
    }

    function getCurrentDayBreakSeconds(date = new Date()) {
        const { weekKey, dayIdx } = getCurrentDayMeta(date);
        const dayData = scheduleData?.[weekKey]?.[dayIdx];
        return dayData ? (ensureDayObject(dayData).breakSeconds || 0) : 0;
    }

    function mergeFreshDailySnapshotIntoLocalSchedule(userData = {}, referenceDate = new Date()) {
        const remoteResetState = getDailySnapshotResetState(userData || {}, referenceDate);
        const remoteSchedule = sanitizeScheduleData(remoteResetState.normalizedData?.schedule || userData?.schedule || {});
        const { weekKey, dayIdx, dateKey } = getCurrentDayMeta(referenceDate);
        const localDayData = ensureDayObject(scheduleData?.[weekKey]?.[dayIdx] || {});
        const remoteDayData = ensureDayObject(remoteSchedule?.[weekKey]?.[dayIdx] || {});
        const explicitDailySeconds = getFreshDailyStudySeconds(remoteResetState.normalizedData, remoteSchedule, referenceDate);
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
        const localHasValidatedStudyActivity = hasValidatedStudyActivityForDate(localDayData, dateKey);
        const remoteHasValidatedStudyActivity = hasValidatedStudyActivityForDate(remoteDayData, dateKey);
        const localRunningToday = !!timerState.session?.isRunning
            && !hasTimerSessionCrossedDayBoundary(timerState.session, referenceDate);
        const remoteExplicitlyEmptyToday = parseInteger(remoteDayData.workedSeconds, 0) <= 0
            && explicitDailySeconds <= 0;
        const shouldTrustRemoteReset = !shouldForceReplaceFromAdmin
            && !localRunningToday
            && remoteExplicitlyEmptyToday
            && (remoteResetState.needsSync || !localHasValidatedStudyActivity || !remoteHasValidatedStudyActivity);
        const nextWorkedSeconds = shouldForceReplaceFromAdmin
            ? Math.max(
                0,
                parseInteger(remoteDayData.workedSeconds, 0),
                explicitDailySeconds,
                adminTimeAdjustment.appliedDaySeconds,
                adminTimeAdjustment.targetSeconds
            )
            : (shouldTrustRemoteReset
                ? Math.max(0, parseInteger(remoteDayData.workedSeconds, 0))
                : Math.max(currentStoredSeconds, explicitDailySeconds));

        if (!shouldForceReplaceFromAdmin && !shouldTrustRemoteReset && nextWorkedSeconds <= currentStoredSeconds) {
            return false;
        }

        if (!scheduleData || typeof scheduleData !== "object") {
            scheduleData = sanitizeScheduleData(remoteSchedule);
        }
        if (!scheduleData[weekKey]) scheduleData[weekKey] = {};

        const nextStudySessions = shouldTrustRemoteReset
            ? normalizeStudySessions(remoteDayData.studySessions || [])
            : mergeStudySessions(localDayData.studySessions || [], remoteDayData.studySessions || []);
        const nextBreakSessions = shouldTrustRemoteReset
            ? normalizeStudySessions(remoteDayData.breakSessions || [])
            : mergeStudySessions(localDayData.breakSessions || [], remoteDayData.breakSessions || []);
        const nextBreakSeconds = shouldTrustRemoteReset
            ? Math.max(0, parseInteger(remoteDayData.breakSeconds, 0))
            : Math.max(parseInteger(localDayData.breakSeconds, 0), parseInteger(remoteDayData.breakSeconds, 0));

        scheduleData[weekKey][dayIdx] = ensureDayObject({
            ...remoteDayData,
            ...localDayData,
            workedSeconds: nextWorkedSeconds,
            breakSeconds: nextBreakSeconds,
            studySessions: nextStudySessions,
            breakSessions: nextBreakSessions
        });

        if (typeof refreshCurrentTotals === "function") {
            refreshCurrentTotals();
        }
        return true;
    }

    function buildRealtimeStudyPayload(options = {}) {
        const safeProfile = resolveWritableCurrentUserProfile();
        scheduleData = sanitizeScheduleData(
            getMostInformativeProfileSchedule(
                scheduleData || {},
                currentUserLiveDoc?.schedule || {},
                currentUserPublicProfileDoc?.schedule || {}
            )
        );
        refreshCurrentTotals();

        const syncTimestamp = Date.now();
        const currentDayMeta = getCurrentDayMeta(new Date());
        const resolvedSelectedTitleId = getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {});
        const resolvedTitleAwards = getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {});
        const currentDayWorkedSeconds = getCurrentDayWorkedSeconds();
        const requestedActiveSession = options.activeSession === undefined ? timerState.session : options.activeSession;
        const activeSession = hasTimerSessionCrossedDayBoundary(requestedActiveSession, new Date(syncTimestamp))
            ? null
            : requestedActiveSession;
        const normalizedActiveMode = normalizeTimerMode(activeSession?.mode);
        const activeStudyTimerRecord = activeSession && activeSession.isRunning && !isBreakTimerMode(normalizedActiveMode)
            ? serializeTimerSession(activeSession)
            : null;
        const activeBreakTimerRecord = activeSession && activeSession.isRunning && isBreakTimerMode(normalizedActiveMode)
            ? serializeTimerSession(activeSession)
            : null;
        const sessionPendingSeconds = activeSession && activeSession.isRunning
            ? getPendingTimerDelta(activeSession)
            : 0;
        const resolvedCurrentSessionTime = activeStudyTimerRecord
            ? (options.currentSessionTime === undefined
                ? sessionPendingSeconds
                : Math.max(0, Math.min(parseInteger(options.currentSessionTime, sessionPendingSeconds), sessionPendingSeconds)))
            : 0;
        const resolvedBreakSessionTime = activeBreakTimerRecord
            ? sessionPendingSeconds
            : 0;
        const resolvedName = safeProfile.username || "Kullanici";
        const legacyWorkingStartedAt = activeStudyTimerRecord
            ? Math.max(
                parseInteger(activeSession.startedAtMs, 0),
                syncTimestamp - (Math.max(0, getTimerElapsedSeconds(activeSession)) * 1000)
            )
            : 0;
        const questionCounters = buildQuestionCounterPayload(scheduleData);
        const resolvedTitleInfo = buildResolvedTitleInfo({
            uid: currentUser?.uid || "",
            schedule: scheduleData,
            activeTimer: activeStudyTimerRecord,
            selectedTitleId: resolvedSelectedTitleId,
            titleAwards: resolvedTitleAwards
        });
        const currentWeekWorkedSeconds = getCurrentWeekWorkedSecondsFromSchedule(scheduleData || {}, new Date(syncTimestamp));

        return {
            schedule: scheduleData,
            name: resolvedName,
            username: resolvedName,
            totalWorkedSeconds: totalWorkedSecondsAllTime || 0,
            totalStudyTime: totalWorkedSecondsAllTime || 0,
            totalTime: Math.max(0, parseInteger(totalWorkedSecondsAllTime, 0)) * 1000,
            totalQuestionsAllTime: totalQuestionsAllTime || 0,
            ...questionCounters,
            selectedTitleId: resolvedTitleInfo.selectedTitleId,
            titleAwards: resolvedTitleInfo.titleAwards,
            dailyStudyTime: currentDayWorkedSeconds,
            todayStudyTime: currentDayWorkedSeconds,
            todayWorkedSeconds: currentDayWorkedSeconds,
            dailyStudyDateKey: currentDayMeta.dateKey,
            dailyDateKey: currentDayMeta.dateKey,
            todayDateKey: currentDayMeta.dateKey,
            weeklyStudyTime: currentWeekWorkedSeconds,
            currentWeekSeconds: currentWeekWorkedSeconds,
            currentSessionTime: resolvedCurrentSessionTime,
            currentBreakSessionTime: resolvedBreakSessionTime,
            legacyWorkingStartedAt,
            activeTimer: activeStudyTimerRecord,
            activeBreakTimer: activeBreakTimerRecord,
            isWorking: isTimerVisibleForLeaderboard(activeStudyTimerRecord),
            isRunning: !!activeStudyTimerRecord?.isRunning,
            isOnBreak: !!activeBreakTimerRecord?.isRunning,
            lastSyncTime: syncTimestamp,
            lastTimerSyncAt: syncTimestamp,
            lastBreakTimerSyncAt: activeBreakTimerRecord ? syncTimestamp : 0,
            lastSavedTimestamp: syncTimestamp,
            sessionFinalized: !(activeStudyTimerRecord || activeBreakTimerRecord),
            emailVerified: !!currentUser?.emailVerified,
            profileImage: safeProfile.profileImage || "",
            about: safeProfile.about || "",
            accountCreatedAt: safeProfile.accountCreatedAt || "",
            studyTrack: safeProfile.studyTrack || "",
            selectedSubjects: safeProfile.selectedSubjects || []
        };
    }

    function hasAnyScheduleEntries(schedule = {}) {
        return Object.values(schedule || {}).some(week => week && Object.keys(week).length > 0);
    }

    function buildOptimisticCurrentUserData(baseData = {}, activeSessionOverride) {
        const safeProfile = resolveWritableCurrentUserProfile(baseData);
        const normalizedLocalSchedule = sanitizeScheduleData(
            getMostInformativeProfileSchedule(
                scheduleData || {},
                currentUserLiveDoc?.schedule || {},
                currentUserPublicProfileDoc?.schedule || {}
            )
        );
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
        const rawActiveSession = activeSessionOverride === undefined ? timerState.session : activeSessionOverride;
        const normalizedActiveMode = normalizeTimerMode(rawActiveSession?.mode);
        const resolvedActiveTimer = rawActiveSession && !isBreakTimerMode(normalizedActiveMode)
            ? serializeTimerSession(rawActiveSession)
            : null;
        const resolvedBreakTimer = rawActiveSession && isBreakTimerMode(normalizedActiveMode)
            ? serializeTimerSession(rawActiveSession)
            : null;
        const visibleRunningSession = rawActiveSession && !isBreakTimerMode(normalizedActiveMode)
            ? rawActiveSession
            : null;
        const resolvedTitleInfo = buildResolvedTitleInfo({
            uid: currentUser?.uid || baseData.uid || "",
            schedule: resolvedSchedule,
            activeTimer: resolvedActiveTimer,
            selectedTitleId: resolvedSelectedTitleId,
            titleAwards: resolvedTitleAwards
        });

        return {
            ...baseData,
            username: safeProfile.username || baseData.username || "Kullanıcı",
            name: safeProfile.username || baseData.name || baseData.username || "Kullanici",
            email: safeProfile.email || currentUser?.email || baseData.email || "",
            isAdmin: typeof isCurrentAdmin === "function" ? isCurrentAdmin() : !!baseData.isAdmin,
            about: safeProfile.about || baseData.about || "",
            profileImage: safeProfile.profileImage || baseData.profileImage || "",
            accountCreatedAt: safeProfile.accountCreatedAt || baseData.accountCreatedAt || "",
            studyTrack: safeProfile.studyTrack || baseData.studyTrack || "",
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
            activeBreakTimer: resolvedBreakTimer,
            isWorking: isTimerRecordRunning(visibleRunningSession),
            isRunning: isTimerRecordRunning(visibleRunningSession),
            isOnBreak: isTimerRecordRunning(resolvedBreakTimer),
            lastSyncTime: Date.now(),
            currentSessionTime: visibleRunningSession ? Math.max(0, getPendingTimerDelta(visibleRunningSession)) : 0,
            currentBreakSessionTime: resolvedBreakTimer ? Math.max(0, getPendingTimerDelta(rawActiveSession)) : 0,
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
        const visibleSession = hasTimerSessionCrossedDayBoundary(timerState.session) ? null : timerState.session;

        return totalLocalSeconds > 0
            || totalLocalQuestions > 0
            || isTimerVisibleForLeaderboard(visibleSession);
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
            if (docIndex < 0) {
                const docData = buildOptimisticCurrentUserData(currentUserLiveDoc || {}, activeSessionOverride);
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
        const visibleSession = hasTimerSessionCrossedDayBoundary(timerState.session) ? null : timerState.session;
        const unsavedDelta = isTimerVisibleForLeaderboard(visibleSession) ? getPendingTimerDelta(visibleSession) : 0;
        const currentDayWorked = getCurrentDayWorkedSeconds() + unsavedDelta;
        const baseWeeklySeconds = getResolvedCurrentWeekWorkedSeconds(
            currentUserLiveDoc || {},
            scheduleData || {},
            new Date()
        );
        const currentWeekTotals = baseWeeklySeconds + unsavedDelta;

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

        maybeRenderAnalyticsIfOpen();
    }

    function parseAnalyticsDateKey(dateKey = "") {
        const normalizedDateKey = String(dateKey || "").trim();
        if (!normalizedDateKey) return new Date();
        const parsed = new Date(`${normalizedDateKey}T12:00:00`);
        return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    }

    function parseWeekKeyParts(weekKey = "") {
        const match = String(weekKey || "").trim().match(/^(\d{4})-W(\d{1,2})$/i);
        if (!match) return null;
        return {
            year: parseInteger(match[1], 0),
            week: parseInteger(match[2], 0)
        };
    }

    function getWeekStartFromWeekKey(weekKey = "") {
        const parts = parseWeekKeyParts(weekKey);
        if (!parts?.year || !parts?.week) return getMondayWeekStart(new Date());

        const januaryFourth = new Date(parts.year, 0, 4);
        januaryFourth.setHours(0, 0, 0, 0);
        const monday = new Date(januaryFourth);
        monday.setDate(januaryFourth.getDate() - ((januaryFourth.getDay() + 6) % 7) + ((parts.week - 1) * 7));
        monday.setHours(0, 0, 0, 0);
        return monday;
    }

    function formatAnalyticsDuration(ms = 0) {
        const totalSeconds = Math.max(0, Math.floor(Math.max(0, parseInteger(ms, 0)) / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}s ${minutes}dk`;
        if (minutes > 0) return `${minutes}dk ${seconds}s`;
        return `${seconds}s`;
    }

    function formatAnalyticsDateLabel(referenceDate = new Date()) {
        return referenceDate.toLocaleDateString("tr-TR", {
            day: "2-digit",
            month: "long",
            year: "numeric",
            weekday: "long"
        });
    }

    function formatAnalyticsWeekLabel(weekKey = "") {
        const weekStart = getWeekStartFromWeekKey(weekKey);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        const sameMonth = weekStart.getMonth() === weekEnd.getMonth() && weekStart.getFullYear() === weekEnd.getFullYear();
        const sameYear = weekStart.getFullYear() === weekEnd.getFullYear();

        if (sameMonth) {
            return `${weekStart.toLocaleDateString("tr-TR", { day: "2-digit" })} - ${weekEnd.toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric" })} haftası`;
        }

        if (sameYear) {
            return `${weekStart.toLocaleDateString("tr-TR", { day: "2-digit", month: "long" })} - ${weekEnd.toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric" })} haftası`;
        }

        return `${weekStart.toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric" })} - ${weekEnd.toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric" })} haftası`;
    }

    function getDayNameFromIndex(dayIdx = 0) {
        return ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"][Math.max(0, Math.min(6, parseInteger(dayIdx, 0)))] || "Gün";
    }

    function getScheduleDayDataByDate(referenceDate = new Date()) {
        scheduleData = sanitizeScheduleData(scheduleData || {});
        const { weekKey, dayIdx, dateKey } = getCurrentDayMeta(referenceDate);
        return {
            weekKey,
            dayIdx,
            dateKey,
            dayData: ensureDayObject(scheduleData?.[weekKey]?.[dayIdx] || {})
        };
    }

    function mergeStudySessionsForDisplay(sessions = []) {
        const normalized = normalizeStudySessions(sessions);
        if (!normalized.length) return [];

        const merged = [];
        normalized.forEach(session => {
            const previous = merged[merged.length - 1];
            if (
                previous
                && previous.type === session.type
                && previous.mode === session.mode
                && session.startTime <= (previous.endTime + 1000)
            ) {
                previous.endTime = Math.max(previous.endTime, session.endTime);
                previous.durationMs = Math.max(0, previous.endTime - previous.startTime);
                previous.duration = previous.durationMs;
                previous.hourRange = buildStudySessionHourRange(previous.startTime, previous.endTime);
                previous.questions = Math.max(previous.questions, session.questions || 0);
                previous.sourceIds = Array.from(new Set([...(previous.sourceIds || []), session.id]));
                return;
            }
            merged.push({
                ...session,
                sourceIds: [session.id]
            });
        });

        return merged;
    }

    function getAnalyticsWeekKeys() {
        const currentWeekKey = typeof getWeekKey === "function" ? getWeekKey(new Date()) : "";
        const keys = new Set([currentWeekKey]);
        Object.keys(scheduleData || {}).forEach(weekKey => {
            if (String(weekKey || "").trim()) keys.add(String(weekKey).trim());
        });
        return [...keys].sort((left, right) => {
            const leftParts = parseWeekKeyParts(left);
            const rightParts = parseWeekKeyParts(right);
            const leftValue = leftParts ? (leftParts.year * 100) + leftParts.week : 0;
            const rightValue = rightParts ? (rightParts.year * 100) + rightParts.week : 0;
            return rightValue - leftValue;
        });
    }

    function buildDailyAnalytics(referenceDate = new Date()) {
        const safeDate = referenceDate instanceof Date ? new Date(referenceDate) : parseAnalyticsDateKey(referenceDate);
        const { dateKey, dayData } = getScheduleDayDataByDate(safeDate);
        const rawStudySessions = normalizeStudySessions(dayData.studySessions || []);
        const rawBreakSessions = normalizeStudySessions(dayData.breakSessions || []);
        const sessions = mergeStudySessionsForDisplay([
            ...rawStudySessions.map(session => ({ ...session, type: "study" })),
            ...rawBreakSessions.map(session => ({ ...session, type: "break" }))
        ]).map(session => ({
            ...session,
            durationLabel: formatAnalyticsDuration(session.durationMs),
            startedAtLabel: formatStudySessionClock(session.startTime),
            endedAtLabel: formatStudySessionClock(session.endTime)
        }));
        const totalDurationMs = Math.max(0, parseInteger(dayData.workedSeconds, 0)) * 1000;
        const totalBreakMs = Math.max(0, parseInteger(dayData.breakSeconds, 0)) * 1000;

        return {
            dateKey,
            dateLabel: formatAnalyticsDateLabel(safeDate),
            totalDurationMs,
            totalDurationLabel: formatAnalyticsDuration(totalDurationMs),
            totalBreakMs,
            totalBreakLabel: formatAnalyticsDuration(totalBreakMs),
            questionCount: Math.max(0, parseInteger(dayData.questions, 0)),
            sessionCount: sessions.length,
            breakCount: rawBreakSessions.length,
            studySessionCount: rawStudySessions.length,
            sessions
        };
    }

    function buildWeeklyAnalytics(weekKey = (typeof getWeekKey === "function" ? getWeekKey(new Date()) : "")) {
        const resolvedWeekKey = String(weekKey || (typeof getWeekKey === "function" ? getWeekKey(new Date()) : "")).trim();
        const weekStart = getWeekStartFromWeekKey(resolvedWeekKey);
        const dayBreakdown = [];

        for (let offset = 0; offset < 7; offset += 1) {
            const dayDate = new Date(weekStart);
            dayDate.setDate(weekStart.getDate() + offset);
            const daily = buildDailyAnalytics(dayDate);
            dayBreakdown.push({
                dayIdx: offset,
                label: getDayNameFromIndex(offset),
                dateKey: daily.dateKey,
                totalDurationMs: daily.totalDurationMs,
                totalDurationLabel: daily.totalDurationLabel,
                totalBreakMs: daily.totalBreakMs,
                totalBreakLabel: daily.totalBreakLabel,
                questionCount: daily.questionCount,
                sessionCount: daily.sessionCount
            });
        }

        const totalDurationMs = dayBreakdown.reduce((sum, item) => sum + Math.max(0, item.totalDurationMs), 0);
        const totalBreakMs = dayBreakdown.reduce((sum, item) => sum + Math.max(0, item.totalBreakMs), 0);
        const totalQuestions = dayBreakdown.reduce((sum, item) => sum + item.questionCount, 0);
        const mostProductiveDay = dayBreakdown.reduce((best, item) => {
            if (!best || item.totalDurationMs > best.totalDurationMs) return item;
            return best;
        }, null);
        const mostBreakDay = dayBreakdown.reduce((best, item) => {
            if (!best || item.totalBreakMs > best.totalBreakMs) return item;
            return best;
        }, null);

        return {
            weekKey: resolvedWeekKey,
            weekLabel: formatAnalyticsWeekLabel(resolvedWeekKey),
            totalDurationMs,
            totalDurationLabel: formatAnalyticsDuration(totalDurationMs),
            totalBreakMs,
            totalBreakLabel: formatAnalyticsDuration(totalBreakMs),
            totalQuestions,
            dayBreakdown,
            mostProductiveDay: mostProductiveDay?.totalDurationMs > 0 ? mostProductiveDay : null
            ,
            mostBreakDay: mostBreakDay?.totalBreakMs > 0 ? mostBreakDay : null
        };
    }

    function renderAnalyticsHero(options = {}) {
        const heroNode = document.getElementById("analytics-hero");
        if (!heroNode) return;

        const label = String(options.label || "").trim();
        const value = String(options.value || "").trim();
        const subtitle = String(options.subtitle || "").trim();
        const meta = String(options.meta || "").trim();

        heroNode.innerHTML = `
            <span class="analytics-hero-label">${escapeHtml(label)}</span>
            <strong class="analytics-hero-value">${escapeHtml(value)}</strong>
            <div class="analytics-hero-subtitle">${escapeHtml(subtitle)}</div>
            ${meta ? `<div class="analytics-hero-meta">${escapeHtml(meta)}</div>` : ""}
            <span class="analytics-hero-signature">designed by cosxomer</span>
        `;
    }

    function removeStoredAnalyticsSessions(dateKey = "", type = "study", sessionIds = []) {
        const normalizedDateKey = String(dateKey || "").trim();
        const normalizedType = String(type || "").trim() === "break" ? "break" : "study";
        const removableIds = Array.isArray(sessionIds)
            ? sessionIds.map(id => String(id || "").trim()).filter(Boolean)
            : [];
        if (!normalizedDateKey || !removableIds.length) return false;

        const targetDate = parseAnalyticsDateKey(normalizedDateKey);
        const { weekKey, dayIdx } = getCurrentDayMeta(targetDate);
        const dayData = ensureWeekDay(weekKey, dayIdx);
        const sessionField = normalizedType === "break" ? "breakSessions" : "studySessions";
        const totalField = normalizedType === "break" ? "breakSeconds" : "workedSeconds";
        const existingSessions = normalizeStudySessions(dayData[sessionField] || []);
        const removableIdSet = new Set(removableIds);
        const removedSessions = existingSessions.filter(session => removableIdSet.has(session.id));
        if (!removedSessions.length) return false;

        const keptSessions = existingSessions.filter(session => !removableIdSet.has(session.id));
        const removedDurationSeconds = Math.round(
            removedSessions.reduce((sum, session) => sum + Math.max(0, parseInteger(session.durationMs, 0)), 0) / 1000
        );

        dayData[sessionField] = keptSessions;
        dayData[totalField] = Math.max(0, parseInteger(dayData[totalField], 0) - removedDurationSeconds);
        scheduleData[weekKey][dayIdx] = ensureDayObject(dayData);
        refreshCurrentTotals();
        return true;
    }

    window.removeAnalyticsSession = function(dateKey = "", type = "study", encodedIds = "") {
        const decodedIds = decodeURIComponent(String(encodedIds || ""))
            .split(",")
            .map(id => String(id || "").trim())
            .filter(Boolean);
        if (!decodedIds.length) return;
        if (!confirm("Bu oturumu analizden ve kayıtlı sürelerden kaldırmak istiyor musun?")) return;

        const removed = removeStoredAnalyticsSessions(dateKey, type, decodedIds);
        if (!removed) {
            safeShowAlert("Silinecek oturum bulunamadı.");
            return;
        }

        saveData({ authorized: true, immediate: true });
        renderSchedule();
        refreshLeaderboardOptimistically();
        maybeRenderAnalyticsIfOpen();
        safeShowAlert("Seçilen oturum kaldırıldı.", "success");
    };

    function renderDailyAnalytics() {
        const summaryNode = document.getElementById("analytics-daily-summary");
        const sessionsNode = document.getElementById("analytics-daily-sessions");
        const dateInput = document.getElementById("analytics-date-input");
        if (!summaryNode || !sessionsNode || !dateInput) return;

        const selectedDate = parseAnalyticsDateKey(
            analyticsState.selectedDateKey
            || getCurrentDayMeta(new Date()).dateKey
        );
        const daily = buildDailyAnalytics(selectedDate);
        analyticsState.selectedDateKey = daily.dateKey;
        dateInput.value = daily.dateKey;

        renderAnalyticsHero({
            label: "Seçili Günün Toplam Çalışması",
            value: daily.totalDurationLabel,
            subtitle: daily.dateLabel,
            meta: `${daily.totalBreakLabel} mola • ${daily.questionCount} soru`
        });

        summaryNode.innerHTML = `
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Seçili Gün</span>
                <strong>${escapeHtml(daily.dateLabel)}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Toplam Çalışma</span>
                <strong>${escapeHtml(daily.totalDurationLabel)}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Toplam Mola</span>
                <strong>${escapeHtml(daily.totalBreakLabel)}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Toplam Soru</span>
                <strong>${daily.questionCount}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Çalışma / Mola</span>
                <strong>${daily.studySessionCount} / ${daily.breakCount}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Gerçek Oturum</span>
                <strong>${daily.sessionCount}</strong>
            </div>
        `;

        if (!daily.sessions.length) {
            sessionsNode.innerHTML = `<div class="analytics-empty">${(daily.totalDurationMs > 0 || daily.totalBreakMs > 0) ? "Bu günün toplam çalışma ve mola süresi kayıtlı, ancak detay saat aralıkları bu kayıtlarda henüz oluşmamış görünüyor." : "Bu gün için kayıtlı çalışma veya mola oturumu görünmüyor. Yeni oturumlar bu ekranda gerçek saat aralıklarıyla listelenecek."}</div>`;
            return;
        }

        sessionsNode.innerHTML = daily.sessions.map((session, index) => `
            <div class="analytics-session-item">
                <div class="analytics-session-head">
                    <div class="analytics-session-main">
                        <span class="analytics-session-index">#${index + 1}</span>
                        <div class="analytics-session-body">
                            <strong class="analytics-session-title">${escapeHtml(session.hourRange)}</strong>
                            <div class="analytics-session-meta">
                                <span style="display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; margin-right:8px; background:${session.type === "break" ? "rgba(56, 189, 248, 0.16)" : "rgba(251, 191, 36, 0.16)"}; color:${session.type === "break" ? "#bae6fd" : "#fde68a"}; border:1px solid ${session.type === "break" ? "rgba(56, 189, 248, 0.35)" : "rgba(251, 191, 36, 0.35)"};">${session.type === "break" ? "Mola" : "Çalışma"}</span>
                                ${escapeHtml(getTimerModeLabel(session.mode))} • ${escapeHtml(session.durationLabel)}
                            </div>
                        </div>
                    </div>
                    <button
                        class="analytics-session-remove"
                        type="button"
                        onclick="removeAnalyticsSession('${escapeHtml(daily.dateKey)}','${escapeHtml(session.type)}','${encodeURIComponent((session.sourceIds || []).join(','))}')"
                        aria-label="Bu oturumu kaldır"
                        title="Bu oturumu kaldır"
                    >
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <span class="analytics-session-time">${escapeHtml(session.startedAtLabel)} - ${escapeHtml(session.endedAtLabel)}</span>
            </div>
        `).join("");
    }

    function renderWeeklyAnalytics() {
        const summaryNode = document.getElementById("analytics-weekly-summary");
        const breakdownNode = document.getElementById("analytics-weekly-breakdown");
        const weekSelect = document.getElementById("analytics-week-select");
        if (!summaryNode || !breakdownNode || !weekSelect) return;

        const availableWeeks = getAnalyticsWeekKeys();
        if (!analyticsState.selectedWeekKey || !availableWeeks.includes(analyticsState.selectedWeekKey)) {
            analyticsState.selectedWeekKey = availableWeeks[0] || (typeof getWeekKey === "function" ? getWeekKey(new Date()) : "");
        }

        weekSelect.innerHTML = availableWeeks.map(weekKey => `
            <option value="${escapeHtml(weekKey)}"${weekKey === analyticsState.selectedWeekKey ? " selected" : ""}>${escapeHtml(formatAnalyticsWeekLabel(weekKey))}</option>
        `).join("");

        const weekly = buildWeeklyAnalytics(analyticsState.selectedWeekKey);
        const bestDayText = weekly.mostProductiveDay
            ? `${weekly.mostProductiveDay.label} (${formatAnalyticsDuration(weekly.mostProductiveDay.totalDurationMs)})`
            : "Henüz kayıtlı çalışma görünmüyor";
        const mostBreakDayText = weekly.mostBreakDay
            ? `${weekly.mostBreakDay.label} (${formatAnalyticsDuration(weekly.mostBreakDay.totalBreakMs)})`
            : "Belirgin mola kaydı görünmüyor";
        const ratioText = weekly.totalDurationMs > 0
            ? `%${Math.round((weekly.totalBreakMs / weekly.totalDurationMs) * 100)}`
            : "%0";

        renderAnalyticsHero({
            label: "Haftalık Toplam Çalışma",
            value: weekly.totalDurationLabel,
            subtitle: weekly.weekLabel,
            meta: `${weekly.totalBreakLabel} mola • ${weekly.totalQuestions} soru`
        });

        summaryNode.innerHTML = `
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Seçili Hafta</span>
                <strong>${escapeHtml(weekly.weekLabel)}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Toplam Çalışma</span>
                <strong>${escapeHtml(weekly.totalDurationLabel)}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Toplam Mola</span>
                <strong>${escapeHtml(weekly.totalBreakLabel)}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Mola / Çalışma Oranı</span>
                <strong>${escapeHtml(ratioText)}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">Toplam Soru</span>
                <strong>${weekly.totalQuestions}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">En Ağır Tempo</span>
                <strong>${escapeHtml(bestDayText)}</strong>
            </div>
            <div class="analytics-summary-card">
                <span class="analytics-summary-label">En Çok Mola</span>
                <strong>${escapeHtml(mostBreakDayText)}</strong>
            </div>
        `;

        const maxDuration = Math.max(1, ...weekly.dayBreakdown.map(day => day.totalDurationMs));
        breakdownNode.innerHTML = weekly.dayBreakdown.map(day => `
            <div class="analytics-week-row">
                <div class="analytics-week-row-top">
                    <strong>${escapeHtml(day.label)}</strong>
                    <span>${escapeHtml(day.totalDurationLabel)} çalışma • ${escapeHtml(day.totalBreakLabel)} mola • ${day.questionCount} soru</span>
                </div>
                <div class="analytics-week-bar-track">
                    <div class="analytics-week-bar-fill" style="width:${Math.max(6, Math.round((day.totalDurationMs / maxDuration) * 100))}%"></div>
                </div>
            </div>
        `).join("");
    }

    function renderAnalyticsPanel() {
        const modal = document.getElementById("analytics-modal");
        if (!modal) return;

        const dailyTabButton = document.getElementById("analytics-tab-daily");
        const weeklyTabButton = document.getElementById("analytics-tab-weekly");
        const dailyPane = document.getElementById("analytics-daily-pane");
        const weeklyPane = document.getElementById("analytics-weekly-pane");

        if (dailyTabButton) dailyTabButton.classList.toggle("is-active", analyticsState.tab === "daily");
        if (weeklyTabButton) weeklyTabButton.classList.toggle("is-active", analyticsState.tab === "weekly");
        if (dailyPane) dailyPane.style.display = analyticsState.tab === "daily" ? "" : "none";
        if (weeklyPane) weeklyPane.style.display = analyticsState.tab === "weekly" ? "" : "none";

        if (analyticsState.tab === "weekly") {
            renderWeeklyAnalytics();
        } else {
            renderDailyAnalytics();
        }
    }

    function maybeRenderAnalyticsIfOpen() {
        const modal = document.getElementById("analytics-modal");
        if (modal?.style.display === "flex") {
            renderAnalyticsPanel();
        }
    }

    window.openAnalyticsModal = function() {
        if (guardVerifiedAccess()) return;
        if (!analyticsState.selectedDateKey) {
            analyticsState.selectedDateKey = getCurrentDayMeta(new Date()).dateKey;
        }
        if (!analyticsState.selectedWeekKey && typeof getWeekKey === "function") {
            analyticsState.selectedWeekKey = getWeekKey(new Date());
        }
        const modal = document.getElementById("analytics-modal");
        if (!modal) return;
        renderAnalyticsPanel();
        modal.style.display = "flex";
        if (typeof syncBodyModalLock === "function") syncBodyModalLock();
    };

    window.closeAnalyticsModal = function() {
        const modal = document.getElementById("analytics-modal");
        if (!modal) return;
        modal.style.display = "none";
        if (typeof syncBodyModalLock === "function") syncBodyModalLock();
    };

    window.setAnalyticsTab = function(tab = "daily") {
        analyticsState.tab = tab === "weekly" ? "weekly" : "daily";
        renderAnalyticsPanel();
    };

    window.handleAnalyticsDateChange = function(value = "") {
        analyticsState.selectedDateKey = String(value || "").trim() || getCurrentDayMeta(new Date()).dateKey;
        renderAnalyticsPanel();
    };

    window.handleAnalyticsWeekChange = function(value = "") {
        analyticsState.selectedWeekKey = String(value || "").trim();
        renderAnalyticsPanel();
    };

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

        if (session?.resumeLocked) {
            clearTimerFinalizedSnapshot(currentUser?.uid || "");
            session = createEmptyTimerSession(mode);
        }

        if (!session || session.mode !== mode) {
            session = createEmptyTimerSession(mode);
        }

        if (isCountdownTimerMode(mode)) {
            const totalSeconds = getPomodoroInputSeconds();
            if (totalSeconds <= 0) {
                safeShowAlert(isBreakTimerMode(mode) ? "Mola suresi 0 olamaz." : "Pomodoro suresi 0 olamaz.");
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
            currentSessionTime: getPendingTimerDelta(session),
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

        persistTimerFinalizedSnapshot(session, Date.now(), {
            elapsedSeconds: session.baseElapsedSeconds,
            reason: "complete"
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
        logTimerReset("manual-reset", {
            mode: timerState.mode,
            resetInputs: resetInputs !== false
        });
        console.log("RESET CALLED");
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
        clearTimerFinalizedSnapshot(currentUser?.uid || "");
        releaseTimerOwnership();

        if (resetInputs && isCountdownTimerMode(timerState.mode)) {
            resetTimerDurationInputs(0);
        }

        await syncRealtimeTimer("reset", {
            activeSession: null,
            currentSessionTime: 0,
            clearActive: true
        });

        timerState.session = createEmptyTimerSession(timerState.mode);
        if (isCountdownTimerMode(timerState.mode)) {
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
        const referenceDate = new Date();
        const storedSession = readStoredTimerSession();
        const storedSessionMatchesUser = !!storedSession
            && (!storedSession.uid || !currentUser?.uid || storedSession.uid === currentUser.uid);
        const finalizedSnapshot = readTimerFinalizedSnapshot();
        const finalizedSnapshotMatchesUser = !!finalizedSnapshot
            && (!finalizedSnapshot.uid || !currentUser?.uid || finalizedSnapshot.uid === currentUser.uid);
        const remoteTimerRecord = userData?.activeTimer || userData?.activeBreakTimer || null;
        const storedResetState = storedSessionMatchesUser
            ? finalizeTimerSessionForNewDay(storedSession, referenceDate, {
                commitElapsed: true,
                persistRecovery: true
            })
            : { didReset: false, resetSignature: "" };
        const remoteResetState = remoteTimerRecord
            ? finalizeTimerSessionForNewDay(remoteTimerRecord, referenceDate, {
                commitElapsed: false,
                persistRecovery: false
            })
            : { didReset: false, resetSignature: "" };
        const remoteSessionCandidate = remoteTimerRecord && !remoteResetState.didReset
            ? remoteTimerRecord
            : null;
        const hasFreshRemoteSession = !!remoteSessionCandidate
            && isTimerRecordRunning(remoteSessionCandidate, referenceDate.getTime());
        const shouldClearRemoteTimer = remoteResetState.didReset || (storedResetState.didReset && !hasFreshRemoteSession);
        const resetSignature = remoteResetState.resetSignature || storedResetState.resetSignature || "";
        const finalizedSessionCandidate = finalizedSnapshotMatchesUser
            ? buildStoppedTimerSessionFromFinalizedSnapshot(finalizedSnapshot, referenceDate)
            : null;
        const seedSession = storedSessionMatchesUser && !storedResetState.didReset
            ? storedSession
            : (remoteSessionCandidate || finalizedSessionCandidate);

        if (seedSession?.mode) {
            timerState.mode = normalizeTimerMode(seedSession.mode);
            try {
                localStorage.setItem(TIMER_MODE_KEY, timerState.mode);
            } catch (error) {
                console.error("Timer modu kaydedilemedi:", error);
            }
        }

        if (seedSession) {
            const seedSessionRunning = !!seedSession.isRunning
                && !hasTimerSessionCrossedDayBoundary(seedSession, referenceDate);
            const frozenElapsedSeconds = getTimerElapsedSeconds(seedSession, referenceDate.getTime());
            timerState.session = {
                mode: normalizeTimerMode(seedSession.mode),
                isRunning: seedSessionRunning,
                baseElapsedSeconds: seedSessionRunning
                    ? Math.max(0, parseInteger(seedSession.baseElapsedSeconds, 0))
                    : frozenElapsedSeconds,
                lastPersistedElapsedSeconds: Math.max(0, parseInteger(seedSession.lastPersistedElapsedSeconds, 0)),
                targetDurationSeconds: Math.max(0, parseInteger(seedSession.targetDurationSeconds, 0)),
                startedAtMs: seedSessionRunning ? Math.max(0, parseInteger(seedSession.startedAtMs, referenceDate.getTime())) : 0,
                lastForcedCheckpointAtMs: Math.max(
                    0,
                    parseInteger(seedSession.lastForcedCheckpointAtMs, parseInteger(seedSession.startedAtMs, 0))
                ),
                sessionDateKey: getTimerSessionDateKey(seedSession, referenceDate),
                updatedAtMs: Math.max(0, parseInteger(seedSession.updatedAtMs, Date.now())),
                lastSeenAtMs: getTimerLastSeenAt(seedSession),
                modalOpen: seedSessionRunning ? !!seedSession.modalOpen : false,
                ownerId: String(seedSession.ownerId || timerInstanceId)
            };
        } else {
            timerState.session = buildFreshTimerSession(timerState.mode, referenceDate);
            if (isCountdownTimerMode(timerState.mode)) {
                timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
            }
        }

        const recoveryState = maybeRecoverInactiveTimerSession(referenceDate.getTime(), {
            syncReason: "restore-recovery",
            showAlert: false,
            modalOpen: isTimerModalOpen()
        });

        if (storedResetState.didReset) {
            persistTimerSessionLocally(null);
        }

        if (storedResetState.didReset || remoteResetState.didReset) {
            clearTimerFinalizedSnapshot(currentUser?.uid || "");
            currentUserLiveDoc = {
                ...(currentUserLiveDoc || {}),
                activeTimer: null,
                activeBreakTimer: null,
                isWorking: false,
                isRunning: false,
                isOnBreak: false,
                currentSessionTime: 0,
                currentBreakSessionTime: 0,
                legacyWorkingStartedAt: 0,
                dailyStudyDateKey: getCurrentDayMeta(referenceDate).dateKey,
                todayDateKey: getCurrentDayMeta(referenceDate).dateKey
            };
        }

        if ((storedResetState.didReset || remoteResetState.didReset) && !shouldClearRemoteTimer && currentUser?.uid) {
            queueAutoDailyResetSync(referenceDate);
        }

        timerDrafts[timerState.mode] = { ...timerState.session };
        if (recoveryState.action === "auto-finalized" && timerState.session) {
            persistTimerFinalizedSnapshot(timerState.session, recoveryState.referenceMs || referenceDate.getTime(), {
                elapsedSeconds: recoveryState.elapsed,
                reason: recoveryState.action
            });
        } else if (timerState.session && !timerState.session.isRunning) {
            const frozenElapsedSeconds = getTimerElapsedSeconds(timerState.session, referenceDate.getTime());
            if (frozenElapsedSeconds > 0 && !hasTimerSessionCrossedDayBoundary(timerState.session, referenceDate)) {
                persistTimerFinalizedSnapshot(timerState.session, referenceDate.getTime(), {
                    elapsedSeconds: frozenElapsedSeconds,
                    reason: "restore-frozen"
                });
            }
        }
        if (timerState.session?.isRunning) {
            isRunning = true;
            startTimerLoops();
        } else if (shouldClearRemoteTimer || recoveryState.action === "auto-finalized") {
            updateLocalActiveTimerSnapshot(null);
            if (shouldClearRemoteTimer) {
                scheduleTimerDayBoundaryResetSync(referenceDate, resetSignature);
            }
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
        logTimerReset("admin-reset", {
            scope: adminTimerReset.scope,
            dateKey: adminTimerReset.dateKey,
            weekKey: adminTimerReset.weekKey
        });
        stopTimerLoops();
        isRunning = false;
        persistTimerSessionLocally(null);
        clearTimerFinalizedSnapshot(currentUser?.uid || "");
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
        if (isCountdownTimerMode(timerState.mode)) {
            timerState.session.targetDurationSeconds = getPomodoroSeedSeconds();
        }
        timerDrafts[timerState.mode] = { ...timerState.session };

        renderTimerUi();
        if (typeof renderSchedule === "function") {
            renderSchedule();
        }
        updateLiveStudyPreview();
        refreshLeaderboardOptimistically(null);

        // Admin bakim aksiyonlari kullaniciya toast olarak gorunmesin;
        // arka planda sessizce uygulanip sadece veriyi yenilesin.

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
        const dayDisplayReferenceMs = getLeaderboardDayDisplayReferenceMs(normalizedUserData, currentDate, now);
        const scheduleDailySeconds = getFreshDailyStudySeconds(normalizedUserData, normalizedUserData?.schedule || {}, currentDate, {
            displayReferenceMs: dayDisplayReferenceMs
        });
        const scheduleWeeklySeconds = getResolvedCurrentWeekWorkedSeconds(
            normalizedUserData,
            normalizedUserData?.schedule || {},
            currentDate
        );
        if (currentLeaderboardTab === "daily") {
            const dayStart = new Date(currentDate);
            dayStart.setHours(0, 0, 0, 0);
            dayStartMs = dayStart.getTime();
            totalSeconds = Math.max(
                0,
                clampWorkedSecondsForDisplay(normalizedUserData?.schedule?.[weekKey]?.[dayIdx]?.workedSeconds, dayStart, dayDisplayReferenceMs),
                scheduleDailySeconds
            );
        } else {
            totalSeconds = scheduleWeeklySeconds;
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

        if (!hasVisibleActiveTimer && liveSessionSnapshot.isLive && liveSessionSnapshot.seconds > 0) {
            totalSeconds += liveSessionSnapshot.seconds;
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

    function getObservedLeaderboardDailySeconds(rawData = {}, referenceDate = new Date()) {
        const safeSchedule = sanitizeScheduleData(rawData.schedule || {});
        return getCurrentDayWorkedSecondsFromSchedule(
            safeSchedule,
            referenceDate,
            getLeaderboardDayDisplayReferenceMs(rawData, referenceDate, referenceDate.getTime())
        );
    }

    function updateInferredWorkingPresence(rawData = {}, docId = "", now = Date.now()) {
        if (!docId) return null;

        const referenceDate = new Date(now);
        const currentDayMeta = getCurrentDayMeta(referenceDate);
        const lastSyncAt = getLeaderboardSessionLastSyncAt(rawData);
        const dailySeconds = getObservedLeaderboardDailySeconds(rawData, referenceDate);
        const previousState = inferredWorkingPresenceByUserId.get(docId) || null;
        const sameDay = previousState?.dateKey === currentDayMeta.dateKey;
        const previousDailySeconds = sameDay ? parseInteger(previousState?.dailySeconds, 0) : 0;
        const previousLastSyncAt = sameDay ? parseInteger(previousState?.lastSyncAt, 0) : 0;
        const explicitWorkingFlag = !!rawData?.isWorking || !!rawData?.isRunning || isTimerRecordRunning(rawData?.activeTimer, now);
        let inferredStartedAtMs = sameDay ? parseInteger(previousState?.inferredStartedAtMs, 0) : 0;

        if (explicitWorkingFlag) {
            inferredStartedAtMs = 0;
        } else if (lastSyncAt > 0 && sameDay && lastSyncAt >= previousLastSyncAt && dailySeconds > previousDailySeconds) {
            inferredStartedAtMs = lastSyncAt;
        } else if (!(lastSyncAt > 0 && (now - lastSyncAt) < REMOTE_TIMER_STALE_MS)) {
            inferredStartedAtMs = 0;
        }

        const nextState = {
            dateKey: currentDayMeta.dateKey,
            dailySeconds,
            lastSyncAt,
            inferredStartedAtMs
        };
        inferredWorkingPresenceByUserId.set(docId, nextState);
        return nextState;
    }

    function resolveObservedWorkingBadge(userId = "", seconds = 0, isWorking = false, now = Date.now()) {
        if (!userId) return !!isWorking;

        const currentDayMeta = getCurrentDayMeta(new Date(now));
        const previousState = observedWorkingBadgeByUserId.get(userId) || null;
        const sameDay = previousState?.dateKey === currentDayMeta.dateKey;
        const previousSeconds = sameDay ? parseInteger(previousState?.seconds, 0) : 0;
        const previousSeenAt = sameDay ? parseInteger(previousState?.seenAtMs, 0) : 0;
        let observedLiveUntilMs = sameDay ? parseInteger(previousState?.observedLiveUntilMs, 0) : 0;

        if (isWorking) {
            observedLiveUntilMs = Math.max(observedLiveUntilMs, now + 20000);
        } else if (sameDay && seconds > previousSeconds && previousSeenAt > 0 && (now - previousSeenAt) <= 5000) {
            observedLiveUntilMs = now + 20000;
        } else if (observedLiveUntilMs <= now) {
            observedLiveUntilMs = 0;
        }

        observedWorkingBadgeByUserId.set(userId, {
            dateKey: currentDayMeta.dateKey,
            seconds: Math.max(0, parseInteger(seconds, 0)),
            seenAtMs: now,
            observedLiveUntilMs
        });

        return !!isWorking || observedLiveUntilMs > now;
    }

    function getTrustedLeaderboardPresenceState(rawData = {}, docId = "", now = Date.now()) {
        const rawCurrentSessionTime = Math.max(0, parseInteger(rawData?.currentSessionTime, 0));
        const activeTimer = rawData?.activeTimer || null;
        const activeTimerRunning = isTimerRecordRunning(activeTimer, now);
        const explicitWorkingFlag = !!rawData?.isWorking || !!rawData?.isRunning || activeTimerRunning;
        const sessionFinalized = rawData?.sessionFinalized === true;
        const lastSyncAt = getLeaderboardSessionLastSyncAt(rawData);
        const syncLooksFresh = lastSyncAt > 0 && (now - lastSyncAt) < REMOTE_TIMER_STALE_MS;
        const inferredPresence = inferredWorkingPresenceByUserId.get(docId) || null;
        const inferredStartedAtMs = Math.max(0, parseInteger(inferredPresence?.inferredStartedAtMs, 0));
        let legacyWorkingStartedAt = Math.max(0, parseInteger(rawData?.legacyWorkingStartedAt, 0));

        if (activeTimerRunning) {
            legacyWorkingStartedAt = Math.max(
                legacyWorkingStartedAt,
                parseInteger(activeTimer?.startedAtMs, 0)
            );
            if (!legacyWorkingStartedAt && rawCurrentSessionTime > 0 && lastSyncAt > 0) {
                legacyWorkingStartedAt = Math.max(0, lastSyncAt - (rawCurrentSessionTime * 1000));
            }
        } else {
            const explicitLegacyFresh = legacyWorkingStartedAt > 0 && (now - legacyWorkingStartedAt) < TIMER_AUTO_STOP_MS;
            if (!explicitLegacyFresh) {
                legacyWorkingStartedAt = 0;
            }

            if (!legacyWorkingStartedAt && explicitWorkingFlag && rawCurrentSessionTime > 0 && syncLooksFresh) {
                legacyWorkingStartedAt = Math.max(0, lastSyncAt - (rawCurrentSessionTime * 1000));
            }
        }

        if (!legacyWorkingStartedAt && !explicitWorkingFlag && inferredStartedAtMs > 0 && syncLooksFresh) {
            legacyWorkingStartedAt = inferredStartedAtMs;
        }

        const legacyLooksFresh = legacyWorkingStartedAt > 0 && (now - legacyWorkingStartedAt) < TIMER_AUTO_STOP_MS;
        const canUseLegacyPresence = !sessionFinalized && legacyLooksFresh;
        const inferredWorking = !explicitWorkingFlag && inferredStartedAtMs > 0 && syncLooksFresh && canUseLegacyPresence;
        const hasRemoteLiveEvidence = rawCurrentSessionTime > 0 || syncLooksFresh || explicitWorkingFlag || inferredStartedAtMs > 0;
        const isWorking = activeTimerRunning
            || (explicitWorkingFlag && canUseLegacyPresence && hasRemoteLiveEvidence)
            || (canUseLegacyPresence && rawCurrentSessionTime > 0)
            || inferredWorking;

        if (isWorking && legacyWorkingStartedAt > 0) {
            legacyWorkingPresenceByUserId.set(docId, { startedAtMs: legacyWorkingStartedAt });
        } else if (docId) {
            legacyWorkingPresenceByUserId.delete(docId);
            legacyWorkingStartedAt = 0;
        }

        return {
            currentSessionTime: rawCurrentSessionTime,
            isWorking,
            isRunning: isWorking,
            legacyWorkingStartedAt,
            lastSyncAt
        };
    }

    function getLeaderboardLiveSessionSnapshot(userData = {}, now = Date.now()) {
        const activeTimer = userData?.activeTimer || null;
        const currentSessionTime = Math.max(0, parseInteger(userData?.currentSessionTime, 0));
        const legacyWorkingStartedAt = Math.max(0, parseInteger(userData?.legacyWorkingStartedAt, 0));
        const sessionFinalized = userData?.sessionFinalized === true;
        const lastSyncAt = getLeaderboardSessionLastSyncAt(userData);
        const isRunning = !!userData?.isRunning || !!userData?.isWorking;
        const activeTimerVisible = isTimerVisibleForLeaderboard(activeTimer, now);
        const legacyIsFresh = !sessionFinalized
            && legacyWorkingStartedAt > 0
            && (now - legacyWorkingStartedAt) < TIMER_AUTO_STOP_MS;

        if (activeTimerVisible) {
            return {
                seconds: Math.max(currentSessionTime, getTimerElapsedSeconds(activeTimer, now)),
                isLive: true,
                lastSyncAt
            };
        }

        if (currentSessionTime <= 0) {
            if (legacyIsFresh && isRunning) {
                const secondsSinceLastSync = lastSyncAt > 0
                    ? Math.max(0, Math.floor((now - lastSyncAt) / 1000))
                    : 0;
                return {
                    seconds: Math.max(
                        0,
                        secondsSinceLastSync,
                        lastSyncAt > 0
                            ? Math.floor((now - legacyWorkingStartedAt) / 1000)
                                - Math.max(0, Math.floor((lastSyncAt - legacyWorkingStartedAt) / 1000))
                            : Math.floor((now - legacyWorkingStartedAt) / 1000)
                    ),
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
                seconds: isRunning ? currentSessionTime : 0,
                isLive: isRunning && currentSessionTime > 0,
                lastSyncAt
            };
        }

        const secondsSinceLastSync = Math.max(0, Math.floor((now - lastSyncAt) / 1000));
        const isFresh = (now - lastSyncAt) < REMOTE_TIMER_STALE_MS;
        const fallbackSeconds = Math.max(currentSessionTime, currentSessionTime + secondsSinceLastSync, secondsSinceLastSync);
        const canExtendWithLegacy = legacyIsFresh && isRunning;

        return {
            seconds: ((isFresh || canExtendWithLegacy) && isRunning) ? fallbackSeconds : 0,
            isLive: (isFresh || canExtendWithLegacy) && isRunning,
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
        const currentWeekSeconds = getResolvedCurrentWeekWorkedSeconds(
            data,
            data.schedule || {},
            new Date()
        );
        const isWorking = currentLeaderboardTab === "daily"
            && resolveObservedWorkingBadge(currentUser?.uid || LOCAL_LEADERBOARD_PREVIEW_ID, seconds, liveSessionSnapshot.isLive);
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
        if (!localEntry) {
            return nextData.sort(compareLeaderboardEntries);
        }

        if (currentUser?.uid) {
            const hasRealCurrentUserRow = nextData.some(user => user && user.uid === currentUser.uid && !user.isLocalPreview);
            if (hasRealCurrentUserRow) {
                return nextData.sort(compareLeaderboardEntries);
            }
        }

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
        const sourceRecency = getLeaderboardSourceRecency(rawData);
        const referenceDate = new Date();
        const currentDayMeta = getCurrentDayMeta(referenceDate);
        const dailyStudyTime = getCurrentDayWorkedSecondsFromSchedule(
            safeSchedule,
            referenceDate,
            getLeaderboardDayDisplayReferenceMs(rawData, referenceDate, Date.now())
        );
        const currentWeekSeconds = getResolvedCurrentWeekWorkedSeconds(rawData, safeSchedule, referenceDate);
        updateInferredWorkingPresence(rawData, docId);
        const presenceState = getTrustedLeaderboardPresenceState(rawData, docId);

        return {
            ...rawData,
            username: String(rawData.username || rawData.name || rawData.email?.split?.("@")?.[0] || "").trim(),
            schedule: safeSchedule,
            dailyStudyTime,
            todayStudyTime: dailyStudyTime,
            todayWorkedSeconds: dailyStudyTime,
            dailyStudyDateKey: currentDayMeta.dateKey,
            todayDateKey: currentDayMeta.dateKey,
            weeklyStudyTime: currentWeekSeconds,
            currentWeekSeconds,
            currentSessionTime: presenceState.currentSessionTime,
            legacyWorkingStartedAt: presenceState.legacyWorkingStartedAt,
            isWorking: presenceState.isWorking,
            isRunning: presenceState.isRunning,
            totalTime: Math.max(parseInteger(rawData.totalTime, 0), parseInteger(rawData.totalWorkedSeconds, 0) * 1000, parseInteger(rawData.totalStudyTime, 0) * 1000),
            lastSyncTime: Math.max(parseInteger(rawData.lastSyncTime, 0), sourceRecency),
            lastTimerSyncAt: Math.max(parseInteger(rawData.lastTimerSyncAt, 0), parseInteger(rawData.lastSyncTime, 0), sourceRecency, presenceState.lastSyncAt)
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
            const referenceDate = new Date();
            const currentDayMeta = getCurrentDayMeta(referenceDate);
            const questionCounters = buildQuestionCounterPayload(safeSchedule);
            updateInferredWorkingPresence(rawData, doc.id);
            const presenceState = getTrustedLeaderboardPresenceState(rawData, doc.id);
            const currentWeekSeconds = getResolvedCurrentWeekWorkedSeconds(rawData, safeSchedule, referenceDate);
            const dailyStudyTime = getCurrentDayWorkedSecondsFromSchedule(
                safeSchedule,
                referenceDate,
                getLeaderboardDayDisplayReferenceMs(rawData, referenceDate, Date.now())
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
                    dailyStudyTime,
                    todayStudyTime: dailyStudyTime,
                    todayWorkedSeconds: dailyStudyTime,
                    dailyStudyDateKey: currentDayMeta.dateKey,
                    todayDateKey: currentDayMeta.dateKey,
                    weeklyStudyTime: currentWeekSeconds,
                    currentWeekSeconds,
                    totalWorkedSeconds,
                    totalStudyTime: Math.max(parseInteger(rawData.totalStudyTime, 0), totalWorkedSeconds),
                    totalTime: Math.max(parseInteger(rawData.totalTime, 0), totalWorkedSeconds * 1000),
                    totalQuestionsAllTime,
                    currentSessionTime: presenceState.currentSessionTime,
                    legacyWorkingStartedAt: presenceState.legacyWorkingStartedAt,
                    activeTimer: rawData.activeTimer || null,
                    isWorking: presenceState.isWorking,
                    isRunning: presenceState.isRunning,
                    lastSyncTime: Math.max(parseInteger(rawData.lastSyncTime, 0), getLeaderboardSourceRecency(rawData)),
                    lastTimerSyncAt: Math.max(parseInteger(rawData.lastSyncTime, 0), getLeaderboardSourceRecency(rawData), presenceState.lastSyncAt)
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
            const referenceDate = new Date();
            const currentDayMeta = getCurrentDayMeta(referenceDate);

            mergedData.schedule = sanitizeScheduleData(profileData.schedule || liveData.schedule || {});
            const mergedDailyStudyTime = getCurrentDayWorkedSecondsFromSchedule(
                mergedData.schedule,
                referenceDate,
                getLeaderboardDayDisplayReferenceMs(mergedData, referenceDate, Date.now())
            );
            const mergedCurrentWeekSeconds = getCurrentWeekWorkedSecondsFromSchedule(mergedData.schedule, referenceDate);
            mergedData.dailyStudyTime = mergedDailyStudyTime;
            mergedData.todayStudyTime = mergedDailyStudyTime;
            mergedData.todayWorkedSeconds = mergedDailyStudyTime;
            mergedData.dailyStudyDateKey = currentDayMeta.dateKey;
            mergedData.todayDateKey = currentDayMeta.dateKey;
            mergedData.weeklyStudyTime = mergedCurrentWeekSeconds;
            mergedData.currentWeekSeconds = mergedCurrentWeekSeconds;
            mergedData.currentSessionTime = Math.max(profileSessionSeconds, liveSessionSeconds);
            mergedData.activeTimer = liveTimerLooksFresher
                ? (liveTimer || profileTimer || null)
                : (profileTimer || liveTimer || null);
            mergedData.lastTimerSyncAt = Math.max(profileRecency, liveRecency);
            mergedData.legacyWorkingStartedAt = Math.max(
                profileLegacyWorkingStartedAt,
                liveLegacyWorkingStartedAt,
                parseInteger(mergedData.activeTimer?.startedAtMs, 0)
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
            const mergedPresenceState = getTrustedLeaderboardPresenceState(mergedData, docId);
            mergedData.legacyWorkingStartedAt = mergedPresenceState.legacyWorkingStartedAt;
            mergedData.isWorking = mergedPresenceState.isWorking;
            mergedData.isRunning = mergedPresenceState.isRunning;

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
            if (currentUserIndex < 0) {
                const optimisticData = buildOptimisticCurrentUserData(currentUserLiveDoc || {});
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
                const now = Date.now();
                const referenceDate = new Date(now);
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
                const currentWeekTotals = getCurrentWeekWorkedSecondsFromSchedule(
                    sanitizeScheduleData(data.schedule || {}),
                    referenceDate
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
                const liveSessionSnapshot = getLeaderboardLiveSessionSnapshot(data, now);
                const hasVisibleActiveTimer = isTimerVisibleForLeaderboard(data.activeTimer || null, now);
                const isFreshDailySnapshot = isDailyStudySnapshotFresh(data, referenceDate);
                const todayScheduleSeconds = getCurrentDayWorkedSecondsFromSchedule(
                    sanitizeScheduleData(data.schedule || {}),
                    referenceDate,
                    getLeaderboardDayDisplayReferenceMs(data, referenceDate, now)
                );

                const isWorking = currentLeaderboardTab === "daily"
                    && resolveObservedWorkingBadge(doc.id, seconds, liveSessionSnapshot.isLive);
                const shouldShowForCurrentTab = currentLeaderboardTab !== "daily"
                    || isFreshDailySnapshot
                    || todayScheduleSeconds > 0
                    || hasVisibleActiveTimer
                    || liveSessionSnapshot.isLive;
                const hasVisibleStats = seconds > 0 || isWorking;

                if (!resolvedUsername || !hasVisibleStats || !shouldShowForCurrentTab) return null;

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

        const handleUsersSnapshot = async snapshot => {
            const docs = mapUserSnapshotDocsToLeaderboardDocs(snapshot.docs || []);
            applyLeaderboardCloudDocs(docs);

            const currentUserDoc = (snapshot.docs || []).find(doc => doc.id === currentUser?.uid) || null;
            const publicProfileData = currentUserPublicProfileBootstrapPromise
                ? await currentUserPublicProfileBootstrapPromise.catch(() => null)
                : currentUserPublicProfileDoc;
            currentUserHasRemoteProfile = !!(currentUserDoc || publicProfileData);
            const currentData = mergeCurrentUserProfileSources(
                currentUserDoc?.data?.() || {},
                publicProfileData || {},
                currentUserLiveDoc || {},
                getCurrentRuntimeProfileSeed()
            );
            const initialSync = !hasBootstrappedUsersRealtime;

            if (currentUserDoc || publicProfileData) {
                syncCurrentUserLiveDoc(currentData, { silent: initialSync });
                applyAdminTimerResetFromUserData(currentData, { silent: initialSync });
            } else {
                currentUserLiveDoc = null;
                currentUserProfileHydrated = false;
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
        inferredWorkingPresenceByUserId = new Map();
        legacyWorkingPresenceByUserId = new Map();
        observedWorkingBadgeByUserId = new Map();
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

        content.classList.toggle("is-stopwatch-mode", isStopwatchTimerMode(timerState.mode));
        updateTimerButtons();
        updateTimerSessionPill();

        const titleNode = content.querySelector("h2");
        if (titleNode) {
            titleNode.textContent = getTimerContextTitle(timerState.mode);
        }

        const displaySeconds = getTimerDisplaySeconds();
        timeRemaining = displaySeconds;
        renderSegmentedTimer(displaySeconds);

        if (timerState.session?.isRunning) {
            updateTimerStatus(isBreakTimerMode(timerState.mode)
                ? (isStopwatchTimerMode(timerState.mode)
                    ? "Mola kronometresi calisiyor. Sure canli olarak takip ediliyor."
                    : "Mola geri sayimi calisiyor. Sure canli olarak takip ediliyor.")
                : (isStopwatchTimerMode(timerState.mode)
                    ? "Kronometre calisiyor. Sure canli olarak takip ediliyor."
                    : "Pomodoro calisiyor. Sure canli olarak takip ediliyor."));
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
        lastTimerDayBoundaryResetSignature = "";
    }

    function bootstrapExtendedUserData(userData = {}) {
        const rawData = userData && typeof userData === "object" ? userData : {};
        const mergedProfile = mergeCurrentUserProfileSources(
            rawData,
            currentUserPublicProfileDoc || {},
            currentUserLiveDoc || {},
            getCurrentRuntimeProfileSeed()
        );
        const dailyResetState = getDailySnapshotResetState(mergedProfile);
        const safeData = dailyResetState.normalizedData;
        clearLoadedUserData();

        if (typeof currentUsername !== "undefined") {
            currentUsername = pickPreferredProfileText(
                [
                    safeData.username,
                    safeData.name,
                    currentUser?.displayName,
                    currentUsername
                ],
                {
                    email: safeData.email || currentUser?.email || ""
                }
            ) || (!currentUserHasRemoteProfile ? (safeData.email?.split?.("@")?.[0] || "") : "");
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
            currentUserProfileHydrated = true;
            if (typeof saveCodexCachedUserProfile === "function") {
                saveCodexCachedUserProfile(currentUser.uid, currentUserLiveDoc, currentUser);
            }
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
                    activeTimer: isTimerVisibleForLeaderboard(timerState.session) ? serializeTimerSession(timerState.session) : null,
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
                syncProfileSaveActionVisibility(!!editable);
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
            const username = sanitizeUsernameInput(document.getElementById("signup-username")?.value || "");
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
                    try {
                        await ensureUsernameAvailable(username, { excludeUid: credential.user.uid });
                    } catch (usernameError) {
                        await cleanupRejectedSignupUser(credential.user);
                        throw usernameError;
                    }

                    const signupPayload = createSignupPayload(username, email, accountCreatedAt);
                    await db.collection("users").doc(credential.user.uid).set(signupPayload, { merge: true });
                    currentUser = credential.user;
                    currentUsername = signupPayload.username;
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

    function getProfileSaveButtons() {
        return ["profile-save-btn-top", "profile-save-btn"]
            .map(id => document.getElementById(id))
            .filter(Boolean);
    }

    function syncProfileSaveActionVisibility(editable = false) {
        const quickActions = document.getElementById("profile-quick-actions");
        const bottomActions = document.querySelector("#profile-modal .profile-modal-actions");
        const topButton = document.getElementById("profile-save-btn-top");
        const bottomButton = document.getElementById("profile-save-btn");

        if (quickActions) {
            quickActions.style.display = editable ? "flex" : "none";
        }

        if (topButton) {
            topButton.style.display = editable ? "inline-flex" : "none";
        }

        if (bottomButton) {
            bottomButton.style.display = "none";
        }

        if (bottomActions) {
            bottomActions.style.display = "none";
        }
    }

    function patchProfileSaveFlow() {
        saveProfileChanges = async function() {
            if (!currentUser) return;

            const saveButtons = getProfileSaveButtons();
            const originalLabels = new Map(saveButtons.map(button => [button.id, button.innerHTML]));
            const newUsername = sanitizeUsernameInput(document.getElementById("profile-username-input")?.value || "");
            const newAbout = document.getElementById("profile-about-input")?.value.trim() || "";
            const newTrack = document.getElementById("profile-track-select")?.value || "";
            const newSubjects = newTrack === "free" ? [] : normalizeSelectedSubjects(newTrack, profileDraftSubjects);

            if (newUsername.length < 2) return showAlert("Kullanıcı adı en az 2 karakter olmalı.");
            if (!newTrack) return showAlert("Önce alanını seç.");
            if (newTrack !== "free" && !newSubjects.length) return showAlert("En az bir ders seç.");

            saveButtons.forEach(button => {
                button.disabled = true;
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Kaydediliyor';
            });

            try {
                await ensureUsernameAvailable(newUsername, { excludeUid: currentUser.uid });

                currentUsername = newUsername;
                currentProfileAbout = newAbout;
                studyTrack = newTrack;
                selectedSubjects = newSubjects;

                if (currentUserLiveDoc && typeof currentUserLiveDoc === "object") {
                    currentUserLiveDoc = {
                        ...currentUserLiveDoc,
                        username: newUsername,
                        normalizedUsername: normalizeUsernameLookup(newUsername),
                        name: newUsername,
                        about: newAbout,
                        studyTrack: newTrack,
                        selectedSubjects: newSubjects
                    };
                }

                refreshCurrentTotals();
                await saveData({ authorized: true, immediate: true });

                const latestPayload = typeof buildUserPayload === "function" ? buildUserPayload() : null;
                if (typeof syncPublicProfileSnapshotSafely === "function") {
                    syncPublicProfileSnapshotSafely(latestPayload);
                }
                if (typeof refreshLeaderboardOptimistically === "function") {
                    refreshLeaderboardOptimistically(null);
                }
                if (typeof renderLiveLeaderboardFromDocs === "function") {
                    renderLiveLeaderboardFromDocs();
                }

                updateProfileButton();
                renderSchedule();
                closeProfileModal();
                updateSubjectReminder();
                showAlert("Profil güncellendi.", "success");
            } catch (error) {
                console.error("Profil kaydi basarisiz:", error);
                if (String(error?.code || error?.message || "") === "username-already-in-use") {
                    showAlert("Bu kullanıcı adı zaten kullanılıyor. Başka bir kullanıcı adı seç.");
                } else {
                    showAlert("Profil güncellenemedi. Lütfen tekrar dene.");
                }
            } finally {
                saveButtons.forEach(button => {
                    button.disabled = false;
                    button.innerHTML = originalLabels.get(button.id) || '<i class="fas fa-save"></i> Profili Kaydet';
                });
            }
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

            if (!canWriteCurrentUserProfileSafely()) {
                console.warn(`${label} profil bootstrap tamamlanmadan atlandi.`);
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

            const mode = normalizeTimerMode(timerState.mode);
            let session = timerState.session;

            if (session?.resumeLocked) {
                clearTimerFinalizedSnapshot(currentUser?.uid || "");
                session = createEmptyTimerSession(mode);
            }

            if (hasTimerSessionCrossedDayBoundary(session)) {
                session = buildFreshTimerSession(mode);
            }

            if (!session || session.mode !== mode) {
                session = createEmptyTimerSession(mode);
            }

            if (isCountdownTimerMode(mode)) {
                const totalSeconds = getPomodoroInputSeconds();
                if (totalSeconds <= 0) {
                    safeShowAlert(isBreakTimerMode(mode) ? "Mola suresi 0 olamaz." : "Pomodoro suresi 0 olamaz.");
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
            session.lastForcedCheckpointAtMs = session.startedAtMs;
            session.sessionDateKey = getCurrentDayMeta(new Date(session.startedAtMs)).dateKey;
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
                currentSessionTime: getPendingTimerDelta(session),
                userTriggeredWrite: true,
                authorized: true
            }), {
                label: "timer-start",
                failureMessage: "Canli senkron gecikti. Sure cihazda korunuyor."
            });
            if (!isBreakTimerMode(mode)) {
                setTimeout(() => {
                    maybeShowDailyTimerGuidance();
                }, 180);
            }
        };

        pauseRealtimeTimer = async function(options = {}) {
            if (!timerState.session) return true;

            const session = timerState.session;
            const commitSourceSession = createCommitSourceSession(session);
            const commitState = commitTimerSessionLocally(commitSourceSession, {
                referenceMs: Date.now(),
                persistRecovery: true
            });
            const elapsed = commitState.committedElapsedSeconds;
            session.baseElapsedSeconds = elapsed;
            session.lastPersistedElapsedSeconds = elapsed;
            session.isRunning = false;
            session.startedAtMs = 0;
            session.modalOpen = false;
            session.lastSeenAtMs = commitState.referenceMs;
            session.sessionDateKey = getCurrentDayMeta(new Date(commitState.referenceMs)).dateKey;
            timerState.session = session;
            timerDrafts[session.mode] = { ...session };
            isRunning = false;
            stopTimerLoops();
            persistTimerSessionLocally(session);
            persistTimerFinalizedSnapshot(session, commitState.referenceMs, {
                elapsedSeconds: elapsed,
                reason: "pause"
            });
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
            const completedMode = normalizeTimerMode(session.mode);
            const commitSourceSession = createCommitSourceSession(session);
            const commitState = commitTimerSessionLocally(commitSourceSession, {
                referenceMs: Date.now(),
                persistRecovery: true
            });
            const elapsed = Math.max(
                parseInteger(session.targetDurationSeconds, 0),
                commitState.committedElapsedSeconds
            );
            session.baseElapsedSeconds = elapsed;
            session.lastPersistedElapsedSeconds = elapsed;
            session.isRunning = false;
            session.startedAtMs = 0;
            session.lastSeenAtMs = commitState.referenceMs;
            session.sessionDateKey = getCurrentDayMeta(new Date(commitState.referenceMs)).dateKey;
            stopTimerLoops();
            isRunning = false;
            releaseTimerOwnership();
            timerState.session = session;
            timerDrafts[normalizeTimerMode(session.mode)] = { ...session };
            persistTimerSessionLocally(session);
            persistTimerFinalizedSnapshot(session, commitState.referenceMs, {
                elapsedSeconds: elapsed,
                reason: isBreakTimerMode(completedMode) ? "break-complete" : "study-complete"
            });
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
            saveData({ authorized: true, immediate: true });
            if (isBreakTimerMode(completedMode)) {
                resetTimerDurationInputs(0);
                timerState.session = createEmptyTimerSession(completedMode);
                if (isCountdownTimerMode(completedMode)) {
                    timerState.session.targetDurationSeconds = 0;
                }
                timerDrafts[completedMode] = { ...timerState.session };
                persistTimerSessionLocally(null);
                renderTimerUi();
                playBreakFinishedAlert();
                safeShowAlert("Mola tamamlandi ve kaydedildi.", "success");
            } else {
                safeShowAlert("Pomodoro oturumu tamamlandi ve sure kaydedildi.", "success");
            }
        };

        resetRealtimeTimer = async function(resetInputs = true, silent = false) {
            logTimerReset("manual-reset", {
                mode: timerState.mode,
                resetInputs: resetInputs !== false
            });
            console.log("RESET CALLED");
            stopTimerLoops();
            isRunning = false;
            timerState.session = null;
            persistTimerSessionLocally(null);
            clearTimerFinalizedSnapshot(currentUser?.uid || "");
            releaseTimerOwnership();

            if (resetInputs && isCountdownTimerMode(timerState.mode)) {
                const hours = document.getElementById("study-hours");
                const minutes = document.getElementById("study-minutes");
                const seconds = document.getElementById("study-seconds");
                if (hours) hours.value = 0;
                if (minutes) minutes.value = 0;
                if (seconds) seconds.value = 0;
            }

            timerState.session = createEmptyTimerSession(timerState.mode);
            if (isCountdownTimerMode(timerState.mode)) {
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
            const modeLabel = getTimerModeLabel(timerState.mode);
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
                        logTimerReset("auth-session-cleared", {
                            reason: "auth-state-null"
                        });
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

            if (isCountdownTimerMode(timerState.mode)) {
                const totalSeconds = getPomodoroInputSeconds();
                timerState.session = createEmptyTimerSession(timerState.mode);
                timerState.session.targetDurationSeconds = totalSeconds;
            } else {
                timerState.session = createEmptyTimerSession(timerState.mode);
            }

            timerDrafts[timerState.mode] = { ...timerState.session };
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
                    const commitState = commitSourceSession
                        ? commitTimerSessionLocally(commitSourceSession, {
                            referenceMs: Date.now(),
                            persistRecovery: true
                        })
                        : {
                            committedElapsedSeconds: 0,
                            referenceMs: Date.now()
                        };
                    const committedElapsedSeconds = commitState.committedElapsedSeconds;

                    if (activeSession) {
                        activeSession.baseElapsedSeconds = committedElapsedSeconds;
                        activeSession.lastPersistedElapsedSeconds = committedElapsedSeconds;
                        activeSession.isRunning = false;
                        activeSession.startedAtMs = 0;
                        activeSession.modalOpen = false;
                        activeSession.lastSeenAtMs = commitState.referenceMs;
                        activeSession.sessionDateKey = getCurrentDayMeta(new Date(commitState.referenceMs)).dateKey;
                        timerState.session = activeSession;
                        timerDrafts[activeSession.mode] = { ...activeSession };
                        isRunning = false;
                        stopTimerLoops();
                        persistTimerSessionLocally(activeSession);
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

                    releaseTimerOwnership();
                    const nextMode = activeSession?.mode || timerState.mode;
                    timerState.mode = nextMode;
                    logTimerReset("manual-save-close", {
                        mode: nextMode,
                        committedElapsedSeconds
                    });
                    timerState.session = null;
                    timerDrafts[nextMode] = null;
                    persistTimerSessionLocally(null);
                    clearTimerFinalizedSnapshot(currentUser?.uid || "");
                    updateLocalActiveTimerSnapshot(null);
                    refreshLeaderboardOptimistically(null);
                    hidePomodoroModal();

                    resetTimerDurationInputs(0);

                    Object.keys(timerDrafts).forEach(modeKey => {
                        timerDrafts[modeKey] = null;
                    });

                    timerState.session = createEmptyTimerSession(nextMode);
                    if (isCountdownTimerMode(nextMode)) {
                        timerState.session.targetDurationSeconds = 0;
                    }
                    timerDrafts[nextMode] = { ...timerState.session };
                    renderTimerUi();
                    renderSchedule();
                    maybeRenderAnalyticsIfOpen();
                    safeShowAlert("Süre kaydedildi. Günlük toplam korundu, sayaç yeni oturum için sıfırlandı.", "success");
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
            if (timerState.session?.isRunning) {
                maybeRecoverInactiveTimerSession(Date.now(), {
                    syncReason: "ui-check",
                    showAlert: false,
                    modalOpen: isTimerModalOpen()
                });
            }
            renderTimerUi();
        };

        showPomodoroModal = (function(originalShowPomodoroModal) {
            return function() {
                if (guardVerifiedAccess()) return;
                if (timerState.session?.isRunning) {
                    maybeRecoverInactiveTimerSession(Date.now(), {
                        syncReason: "modal-show-recovery",
                        showAlert: true,
                        modalOpen: true
                    });
                }
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
                        currentSessionTime: getPendingTimerDelta(timerState.session),
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
                        currentSessionTime: getPendingTimerDelta(timerState.session),
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
            const mergedProfile = mergeCurrentUserProfileSources(
                getCurrentRuntimeProfileSeed(),
                currentUserLiveDoc || {},
                currentUserPublicProfileDoc || {},
                basePayload
            );
            const resolvedEmail = currentUser?.email || mergedProfile.email || basePayload.email || "";
            const resolvedUsername = pickPreferredProfileText(
                [
                    currentUsername,
                    mergedProfile.username,
                    mergedProfile.name,
                    basePayload.username,
                    basePayload.name
                ],
                { email: resolvedEmail }
            ) || (!currentUserHasRemoteProfile ? (resolvedEmail?.split?.("@")?.[0] || "") : "") || "Kullanici";
            const resolvedStudyTrack = pickPreferredProfileText(
                [studyTrack, mergedProfile.studyTrack, basePayload.studyTrack],
                { allowWeak: true }
            );
            const resolvedSelectedSubjects = typeof normalizeSelectedSubjects === "function"
                ? normalizeSelectedSubjects(
                    resolvedStudyTrack || "",
                    getFirstNonEmptyArray(
                        selectedSubjects,
                        mergedProfile.selectedSubjects,
                        basePayload.selectedSubjects
                    )
                )
                : getFirstNonEmptyArray(
                    selectedSubjects,
                    mergedProfile.selectedSubjects,
                    basePayload.selectedSubjects
                );
            const resolvedSchedule = getMostInformativeProfileSchedule(
                scheduleData,
                mergedProfile.schedule,
                basePayload.schedule
            );
            const resolvedTotalWorkedSeconds = Math.max(
                totalWorkedSecondsAllTime || 0,
                parseInteger(mergedProfile.totalWorkedSeconds, 0),
                parseInteger(mergedProfile.totalStudyTime, 0),
                parseInteger(basePayload.totalWorkedSeconds, 0),
                parseInteger(basePayload.totalStudyTime, 0),
                typeof calculateTotalWorkedSecondsFromSchedule === "function"
                    ? calculateTotalWorkedSecondsFromSchedule(resolvedSchedule)
                    : 0
            );
            const resolvedTotalQuestionsAllTime = Math.max(
                totalQuestionsAllTime || 0,
                parseInteger(mergedProfile.totalQuestionsAllTime, 0),
                parseInteger(basePayload.totalQuestionsAllTime, 0),
                typeof calculateTotalQuestionsFromSchedule === "function"
                    ? calculateTotalQuestionsFromSchedule(resolvedSchedule)
                    : 0
            );
            const questionCounters = buildQuestionCounterPayload(resolvedSchedule);
            const activeStudySession = isTimerVisibleForLeaderboard(timerState.session) ? timerState.session : null;
            const activeTimerRecord = activeStudySession ? serializeTimerSession(activeStudySession) : null;
            const activeBreakTimerRecord = timerState.session?.isRunning && isBreakTimerMode(timerState.session?.mode)
                ? serializeTimerSession(timerState.session)
                : null;
            const timerPendingSeconds = activeStudySession?.isRunning
                ? getPendingTimerDelta(activeStudySession)
                : 0;
            const legacyWorkingStartedAt = activeStudySession?.isRunning
                ? Math.max(
                    parseInteger(activeStudySession.startedAtMs, 0),
                    syncTimestamp - (Math.max(0, getTimerElapsedSeconds(activeStudySession)) * 1000)
                )
                : 0;
            const titleInfo = buildResolvedTitleInfo({
                uid: currentUser?.uid || basePayload.uid || "",
                schedule: resolvedSchedule,
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
                username: resolvedUsername,
                normalizedUsername: normalizeUsernameLookup(resolvedUsername),
                name: pickPreferredProfileText(
                    [resolvedUsername, mergedProfile.name, basePayload.name, basePayload.username],
                    { email: resolvedEmail, allowWeak: true }
                ) || resolvedUsername,
                email: resolvedEmail,
                ...adminProfile,
                emailVerified: !!currentUser?.emailVerified,
                about: currentProfileAbout || mergedProfile.about || basePayload.about || "",
                profileImage: currentProfileImage || mergedProfile.profileImage || basePayload.profileImage || "",
                accountCreatedAt: currentAccountCreatedAt || mergedProfile.accountCreatedAt || basePayload.accountCreatedAt || new Date().toISOString(),
                studyTrack: resolvedStudyTrack || "",
                selectedSubjects: resolvedSelectedSubjects,
                notes: normalizeUserNotes((userNotes && userNotes.length) ? userNotes : (mergedProfile.notes || basePayload.notes || [])),
                noteFolders: normalizeNoteFolders((noteFolders && noteFolders.length) ? noteFolders : (mergedProfile.noteFolders || basePayload.noteFolders || [])),
                schedule: resolvedSchedule,
                totalWorkedSeconds: resolvedTotalWorkedSeconds,
                totalStudyTime: resolvedTotalWorkedSeconds,
                totalTime: Math.max(0, parseInteger(resolvedTotalWorkedSeconds, 0)) * 1000,
                totalQuestionsAllTime: resolvedTotalQuestionsAllTime,
                ...questionCounters,
                selectedTitleId: titleInfo.selectedTitleId,
                titleAwards: titleInfo.titleAwards,
                dailyStudyTime: getCurrentDayWorkedSeconds(),
                todayStudyTime: getCurrentDayWorkedSeconds(),
                todayWorkedSeconds: getCurrentDayWorkedSeconds(),
                dailyStudyDateKey: getCurrentDayMeta(new Date()).dateKey,
                dailyDateKey: getCurrentDayMeta(new Date()).dateKey,
                todayDateKey: getCurrentDayMeta(new Date()).dateKey,
                currentSessionTime: timerPendingSeconds,
                currentBreakSessionTime: activeBreakTimerRecord ? getPendingTimerDelta(timerState.session) : 0,
                legacyWorkingStartedAt,
                activeTimer: activeTimerRecord,
                activeBreakTimer: activeBreakTimerRecord,
                isWorking: isTimerRecordRunning(activeStudySession),
                isRunning: !!activeStudySession?.isRunning,
                isOnBreak: !!activeBreakTimerRecord?.isRunning,
                lastSyncTime: syncTimestamp,
                lastTimerSyncAt: syncTimestamp,
                lastBreakTimerSyncAt: activeBreakTimerRecord ? syncTimestamp : 0,
                lastSavedTimestamp: syncTimestamp,
                sessionFinalized: !(activeTimerRecord || activeBreakTimerRecord)
            };
        };

        if (typeof getCurrentUserSeedData === "function") {
            const originalGetCurrentUserSeedData = getCurrentUserSeedData;
            getCurrentUserSeedData = function() {
                const seed = originalGetCurrentUserSeedData();
                const mergedProfile = mergeCurrentUserProfileSources(
                    getCurrentRuntimeProfileSeed(),
                    currentUserLiveDoc || {},
                    currentUserPublicProfileDoc || {},
                    seed
                );
                const resolvedEmail = currentUser?.email || mergedProfile.email || seed.email || "";
                const resolvedUsername = pickPreferredProfileText(
                    [currentUsername, mergedProfile.username, mergedProfile.name, seed.username, seed.name],
                    { email: resolvedEmail }
                ) || (!currentUserHasRemoteProfile ? (resolvedEmail?.split?.("@")?.[0] || "") : "") || "Kullanici";
                const resolvedStudyTrack = pickPreferredProfileText(
                    [studyTrack, mergedProfile.studyTrack, seed.studyTrack],
                    { allowWeak: true }
                );
                const resolvedSelectedSubjects = typeof normalizeSelectedSubjects === "function"
                    ? normalizeSelectedSubjects(
                        resolvedStudyTrack || "",
                        getFirstNonEmptyArray(selectedSubjects, mergedProfile.selectedSubjects, seed.selectedSubjects)
                    )
                    : getFirstNonEmptyArray(selectedSubjects, mergedProfile.selectedSubjects, seed.selectedSubjects);
                const titleInfo = buildResolvedTitleInfo({
                    uid: currentUser?.uid || seed.uid || "",
                    schedule: scheduleData,
                    activeTimer: isTimerVisibleForLeaderboard(timerState.session) ? serializeTimerSession(timerState.session) : null,
                    selectedTitleId: getStoredSelectedTitleId(currentProfileModalData || {}, currentUserLiveDoc || {}, seed),
                    titleAwards: getStoredTitleAwards(currentProfileModalData || {}, currentUserLiveDoc || {}, seed)
                });
                const activeBreakTimerRecord = timerState.session?.isRunning && isBreakTimerMode(timerState.session?.mode)
                    ? serializeTimerSession(timerState.session)
                    : null;
                return {
                    ...seed,
                    username: resolvedUsername,
                    normalizedUsername: normalizeUsernameLookup(resolvedUsername),
                    name: pickPreferredProfileText(
                        [resolvedUsername, mergedProfile.name, seed.name, seed.username],
                        { email: resolvedEmail, allowWeak: true }
                    ) || resolvedUsername,
                    email: resolvedEmail,
                    about: currentProfileAbout || mergedProfile.about || seed.about || "",
                    profileImage: currentProfileImage || mergedProfile.profileImage || seed.profileImage || "",
                    accountCreatedAt: currentAccountCreatedAt || mergedProfile.accountCreatedAt || seed.accountCreatedAt || new Date().toISOString(),
                    studyTrack: resolvedStudyTrack || "",
                    selectedSubjects: resolvedSelectedSubjects,
                    noteFolders: normalizeNoteFolders(noteFolders),
                    totalStudyTime: totalWorkedSecondsAllTime || 0,
                    totalTime: Math.max(0, parseInteger(totalWorkedSecondsAllTime, 0)) * 1000,
                    selectedTitleId: titleInfo.selectedTitleId,
                    titleAwards: titleInfo.titleAwards,
                    dailyStudyTime: getCurrentDayWorkedSeconds(),
                    todayStudyTime: getCurrentDayWorkedSeconds(),
                    todayWorkedSeconds: getCurrentDayWorkedSeconds(),
                    dailyStudyDateKey: getCurrentDayMeta(new Date()).dateKey,
                    dailyDateKey: getCurrentDayMeta(new Date()).dateKey,
                    todayDateKey: getCurrentDayMeta(new Date()).dateKey,
                    currentSessionTime: isTimerVisibleForLeaderboard(timerState.session) ? getPendingTimerDelta(timerState.session) : 0,
                    currentBreakSessionTime: activeBreakTimerRecord ? getPendingTimerDelta(timerState.session) : 0,
                    activeTimer: isTimerVisibleForLeaderboard(timerState.session) ? serializeTimerSession(timerState.session) : null,
                    activeBreakTimer: activeBreakTimerRecord,
                    isRunning: !!(isTimerVisibleForLeaderboard(timerState.session) && timerState.session?.isRunning),
                    isOnBreak: !!activeBreakTimerRecord?.isRunning,
                    lastSyncTime: Date.now(),
                    lastSavedTimestamp: Date.now(),
                    sessionFinalized: !(isTimerVisibleForLeaderboard(timerState.session) || activeBreakTimerRecord),
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

            const isWorking = !!status && !isBreakTimerMode(timerState.session?.mode);
            const now = Date.now();
            const sessionElapsedSeconds = isWorking && timerState.session?.isRunning
                ? Math.max(0, getTimerElapsedSeconds(timerState.session))
                : 0;
            const sessionPendingSeconds = isWorking && timerState.session?.isRunning
                ? Math.max(0, getPendingTimerDelta(timerState.session))
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
                currentSessionTime: isWorking ? sessionPendingSeconds : 0,
                legacyWorkingStartedAt: nextLegacyWorkingStartedAt,
                lastSyncTime: now,
                lastTimerSyncAt: now,
                totalTime: Math.max(0, parseInteger(totalWorkedSecondsAllTime, 0)) * 1000,
                activeTimer: isWorking && timerState.session ? serializeTimerSession(timerState.session) : null,
                activeBreakTimer: timerState.session?.isRunning && isBreakTimerMode(timerState.session?.mode)
                    ? serializeTimerSession(timerState.session)
                    : null,
                isOnBreak: timerState.session?.isRunning && isBreakTimerMode(timerState.session?.mode)
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
            maybeRenderAnalyticsIfOpen();
        };
    }

    function attachRealtimeListeners() {
        auth.onAuthStateChanged(async user => {
            ensureVerificationCard();
            applyTurkishInputSupport();

            if (!user) {
                currentUser = null;
                currentUserLiveDoc = null;
                currentUserPublicProfileDoc = null;
                currentUserPublicProfileBootstrapPromise = null;
                currentUserProfileHydrated = false;
                currentUserHasRemoteProfile = false;
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
                currentUserProfileHydrated = false;
                currentUserHasRemoteProfile = false;
                const cachedProfile = typeof getCodexCachedUserProfile === "function"
                    ? getCodexCachedUserProfile(user.uid)
                    : null;
                if (cachedProfile && typeof cachedProfile === "object") {
                    currentUserHasRemoteProfile = true;
                    bootstrapExtendedUserData(cachedProfile);
                }
                currentUserPublicProfileBootstrapPromise = db.collection(PUBLIC_PROFILE_COLLECTION).doc(user.uid).get()
                    .then(doc => {
                        currentUserPublicProfileDoc = doc.exists ? (doc.data() || {}) : null;
                        currentUserHasRemoteProfile = currentUserHasRemoteProfile || !!doc.exists;
                        return currentUserPublicProfileDoc;
                    })
                    .catch(error => {
                        console.error("Kullanici public profil verisi yuklenemedi:", error);
                        currentUserPublicProfileDoc = null;
                        return null;
                    });
                localStorage.setItem(VERIFY_EMAIL_KEY, user.email || "");

            try {
                await user.reload();
            } catch (error) {
                console.error("Kullanici yenilenemedi:", error);
            }

            hideVerificationGate();
            hasBootstrappedUsersRealtime = false;
            setTimeout(() => {
                maybeShowDailySupportGuidance();
            }, 220);
            subscribeRealtimeLeaderboard();
        });

        document.addEventListener("visibilitychange", () => {
            if (document.hidden && timerState.session?.isRunning) {
                const hiddenCheckpoint = captureRunningTimerCheckpoint(timerState.session, Date.now(), {
                    bumpCheckpoint: true,
                    touchSeen: true,
                    modalOpen: isTimerModalOpen(),
                    persistRecovery: true
                });
                if (!hiddenCheckpoint) {
                    touchTimerVisibility(Date.now(), { modalOpen: isTimerModalOpen(), persist: true });
                }
                syncRealtimeTimer("visibility-hidden", {
                    activeSession: timerState.session,
                    currentSessionTime: getPendingTimerDelta(timerState.session),
                    userTriggeredWrite: true,
                    authorized: true
                }).catch(error => {
                    console.error("Gizli sekme timer senkronu basarisiz:", error);
                });
            } else if (!document.hidden && timerState.session?.isRunning) {
                const recoveryState = maybeRecoverInactiveTimerSession(Date.now(), {
                    syncReason: "visibility-visible-recovery",
                    showAlert: true,
                    modalOpen: isTimerModalOpen()
                });
                if (recoveryState.action !== "auto-finalized" && timerState.session?.isRunning) {
                    touchTimerVisibility(Date.now(), { modalOpen: isTimerModalOpen(), persist: true });
                    maybeTriggerForcedHourlyCheckpoint(Date.now());
                    syncRealtimeTimer("visibility-visible", {
                        activeSession: timerState.session,
                        currentSessionTime: getPendingTimerDelta(timerState.session),
                        userTriggeredWrite: true,
                        authorized: true
                    }).catch(error => {
                        console.error("Gorunur sekme timer senkronu basarisiz:", error);
                    });
                }
            }
        });

        window.addEventListener("pagehide", () => {
            if (timerState.session?.isRunning) {
                const hiddenCheckpoint = captureRunningTimerCheckpoint(timerState.session, Date.now(), {
                    bumpCheckpoint: true,
                    touchSeen: true,
                    modalOpen: isTimerModalOpen(),
                    persistRecovery: true
                });
                if (!hiddenCheckpoint) {
                    touchTimerVisibility(Date.now(), { modalOpen: isTimerModalOpen(), persist: true });
                }
                syncRealtimeTimer("pagehide", {
                    activeSession: timerState.session,
                    currentSessionTime: getPendingTimerDelta(timerState.session),
                    userTriggeredWrite: true,
                    authorized: true
                }).catch(error => {
                    console.error("Pagehide timer senkronu basarisiz:", error);
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

        const rawCode = String(error?.code || "").toLowerCase();
        const rawMessage = String(error?.message || "").toUpperCase();
        if (rawCode === "username-already-in-use" || rawMessage.includes("USERNAME-ALREADY-IN-USE")) {
            return "Bu kullanıcı adı zaten kullanılıyor. Başka bir kullanıcı adı seç.";
        }
        if (rawCode === "username-too-short") {
            return "Kullanıcı adı en az 2 karakter olmalı.";
        }
        if (rawCode === "auth/email-already-in-use") {
            return "Bu e-posta zaten kayıtlı. Giriş yapabilir veya şifre sıfırlayabilirsin.";
        }
        if (rawCode === "auth/invalid-email") {
            return "Geçerli bir e-posta adresi yaz.";
        }
        if (rawCode === "auth/weak-password") {
            return "Şifre çok zayıf. En az 6 karakter kullan.";
        }
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
        patchProfileSaveFlow();
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
            if (isCountdownTimerMode(timerState.mode)) {
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

