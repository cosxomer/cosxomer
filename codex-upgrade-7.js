(() => {
    const VERIFY_MESSAGE = "Lütfen e-posta adresini kontrol et. Doğrulama bağlantısı gönderildi; büyük ihtimalle spam/junk klasörüne de düşebilir, lütfen orayı da kontrol et.";
    const RESET_PASSWORD_MESSAGE = "Şifre sıfırlama bağlantısı e-posta adresine gönderildi. Büyük ihtimalle spam/junk klasörüne de düşebilir, lütfen orayı da kontrol et.";
    const VERIFY_COOLDOWN_MS = 30000;
    const TIMER_SYNC_MS = 12000;
    const TIMER_OWNER_TTL_MS = 15000;
    const TIMER_OWNER_KEY = "codexTimerOwnerV1";
    const TIMER_OWNER_AT_KEY = "codexTimerOwnerAtV1";
    const TIMER_STORAGE_KEY = "codexRealtimeTimerStateV1";
    const TIMER_MODE_KEY = "codexRealtimeTimerModeV1";
    const VERIFY_EMAIL_KEY = "codexVerifyEmailV1";
    const VERIFY_COOLDOWN_KEY = "codexVerifyCooldownUntilV1";
    const NOTE_FOLDER_ALL_ID = "__all__";
    const NOTE_FOLDER_DEFAULT_ID = "general";
    const FREE_GENERAL_SUBJECT = "free_general";
    const QUESTION_LIMIT = 500;
    const timerInstanceId = `timer_${Math.random().toString(36).slice(2, 10)}`;

    let noteFolders = [];
    let activeNoteFolderId = NOTE_FOLDER_ALL_ID;
    let activeQuestionDayIdx = null;
    let verifyCooldownInterval = null;
    let leaderboardRealtimeUnsubscribe = null;
    let leaderboardRealtimeDocs = [];
    let leaderboardLiveInterval = null;
    let timerSyncInterval = null;
    let timerOwnerInterval = null;
    let timerOwnershipObserved = false;
    let hasTimerControl = false;
    let requiresEmailVerification = false;
    let taskDragState = null;

    const timerState = {
        mode: localStorage.getItem(TIMER_MODE_KEY) || "pomodoro",
        session: null,
        syncing: false
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
                <div class="email-verify-card__icon">📩</div>
                <h3>Email Doğrulaması Gerekli</h3>
                <p id="email-verification-message">${escapeHtml(VERIFY_MESSAGE)}</p>
                <div id="email-verification-meta" class="email-verify-card__meta"></div>
                <div class="email-verify-card__actions">
                    <button id="email-verification-resend-btn" type="button" style="background-color: var(--accent-color); color: var(--header-text);">
                        Tekrar Gönder
                    </button>
                    <button id="email-verification-refresh-btn" type="button" style="background-color: var(--countdown-fill); color: var(--header-text);">
                        Kontrol Et
                    </button>
                    <button id="email-verification-logout-btn" type="button" style="background-color: var(--button-bg); color: var(--header-text);">
                        Çıkış Yap
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
        return {
            username,
            email,
            emailVerified: false,
            requiresEmailVerification: true,
            isAdmin: typeof isAdminIdentity === "function" ? isAdminIdentity(username, email) : false,
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
            dailyStudyTime: 0,
            currentSessionTime: 0,
            activeTimer: null,
            isWorking: false,
            lastTimerSyncAt: Date.now()
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

        return db.collection("users").doc(user.uid).set(patch, { merge: true }).catch(error => {
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

    function serializeTimerSession(session) {
        if (!session) return null;
        return {
            uid: currentUser?.uid || "",
            mode: session.mode,
            isRunning: !!session.isRunning,
            baseElapsedSeconds: Math.max(0, parseInteger(session.baseElapsedSeconds, 0)),
            lastPersistedElapsedSeconds: Math.max(0, parseInteger(session.lastPersistedElapsedSeconds, 0)),
            targetDurationSeconds: Math.max(0, parseInteger(session.targetDurationSeconds, 0)),
            startedAtMs: session.isRunning ? parseInteger(session.startedAtMs, Date.now()) : 0,
            updatedAtMs: Date.now(),
            ownerId: timerInstanceId
        };
    }

    function persistTimerSessionLocally(session) {
        if (!session || !currentUser) {
            localStorage.removeItem(TIMER_STORAGE_KEY);
            return;
        }
        localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(serializeTimerSession(session)));
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

    function createEmptyTimerSession(mode = timerState.mode) {
        return {
            mode,
            isRunning: false,
            baseElapsedSeconds: 0,
            lastPersistedElapsedSeconds: 0,
            targetDurationSeconds: mode === "pomodoro" ? getPomodoroInputSeconds() : 0,
            startedAtMs: 0
        };
    }

    function getPomodoroInputSeconds() {
        const hours = clampNumber(document.getElementById("study-hours")?.value, 0, 9);
        const minutes = clampNumber(document.getElementById("study-minutes")?.value, 0, 59);
        const seconds = clampNumber(document.getElementById("study-seconds")?.value, 0, 59);
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    function getTimerElapsedSeconds(session = timerState.session, now = Date.now()) {
        if (!session) return 0;
        const baseElapsed = Math.max(0, parseInteger(session.baseElapsedSeconds, 0));
        const targetDuration = Math.max(0, parseInteger(session.targetDurationSeconds, 0));
        if (!session.isRunning || !session.startedAtMs) {
            return session.mode === "pomodoro" && targetDuration > 0
                ? Math.min(baseElapsed, targetDuration)
                : baseElapsed;
        }
        const runtime = Math.max(0, Math.floor((now - parseInteger(session.startedAtMs, now)) / 1000));
        const elapsed = baseElapsed + runtime;
        return session.mode === "pomodoro" && targetDuration > 0
            ? Math.min(elapsed, targetDuration)
            : elapsed;
    }

    function isTimerRecordRunning(timerRecord, now = Date.now()) {
        if (!timerRecord || !timerRecord.isRunning) return false;
        if ((timerRecord.mode || "pomodoro") !== "pomodoro") return true;

        const targetDuration = Math.max(0, parseInteger(timerRecord.targetDurationSeconds, 0));
        if (targetDuration <= 0) return true;

        const baseElapsed = Math.max(0, parseInteger(timerRecord.baseElapsedSeconds, 0));
        const runtime = timerRecord.startedAtMs
            ? Math.max(0, Math.floor((now - parseInteger(timerRecord.startedAtMs, now)) / 1000))
            : 0;

        return (baseElapsed + runtime) < targetDuration;
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
            startPauseButton.innerHTML = `<i class="fas fa-play"></i> ${isStopwatch ? "Başlat" : "Pomodoro Başlat"}`;
        }

        resetButton.innerHTML = '<i class="fas fa-rotate-left"></i> Sıfırla';
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
        pill.innerHTML = `<i class="fas fa-wave-square"></i> ${modeLabel} • Otomatik kayıt açık${unsynced > 0 ? ` • ${unsynced}s bekleyen senkron` : ""}`;
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
            updateTimerStatus("Süre çalışıyor.");
        } else {
            updateTimerStatus("");
        }

        updateLiveStudyPreview();
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
                applyStudyDelta(getPendingTimerDelta(timerState.session));
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
                ? "<strong>Kronometre</strong> 00:00:00’dan başlar ve yukarı sayar."
                : "<strong>Pomodoro</strong> geri sayım yapar ve süre dolunca oturumu tamamlar.";
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
                    timerState.session.targetDurationSeconds = getPomodoroInputSeconds() || 1500;
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

            if (timerState.mode === "pomodoro" && getTimerDisplaySeconds() <= 0) {
                completePomodoroSession();
            }
        }, 1000);

        timerSyncInterval = setInterval(() => {
            if (timerState.session?.isRunning) {
                syncRealtimeTimer("interval");
            }
        }, TIMER_SYNC_MS);

        timerOwnerInterval = setInterval(() => {
            refreshTimerOwnership();
        }, Math.max(3000, Math.floor(TIMER_OWNER_TTL_MS / 3)));
    }

    function getPendingTimerDelta(session = timerState.session) {
        if (!session) return 0;
        return Math.max(0, getTimerElapsedSeconds(session) - parseInteger(session.lastPersistedElapsedSeconds, 0));
    }

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
        return ensureWeekDay(weekKey, dayIdx).workedSeconds || 0;
    }

    function buildRealtimeStudyPayload(options = {}) {
        scheduleData = sanitizeScheduleData(scheduleData || {});
        refreshCurrentTotals();

        const currentDayWorkedSeconds = getCurrentDayWorkedSeconds();
        const activeSession = options.activeSession === undefined ? timerState.session : options.activeSession;

        return {
            schedule: scheduleData,
            totalWorkedSeconds: totalWorkedSecondsAllTime || 0,
            totalStudyTime: totalWorkedSecondsAllTime || 0,
            totalQuestionsAllTime: totalQuestionsAllTime || 0,
            dailyStudyTime: currentDayWorkedSeconds,
            currentSessionTime: options.currentSessionTime === undefined ? (activeSession?.isRunning ? getTimerElapsedSeconds(activeSession) : 0) : options.currentSessionTime,
            activeTimer: activeSession ? serializeTimerSession(activeSession) : null,
            isWorking: isTimerRecordRunning(activeSession),
            lastTimerSyncAt: Date.now(),
            emailVerified: !!currentUser?.emailVerified
        };
    }

    function buildOptimisticCurrentUserData(activeSessionOverride) {
        return {
            username: currentUsername || "Kullanıcı",
            email: currentUser?.email || "",
            isAdmin: typeof isCurrentAdmin === "function" ? isCurrentAdmin() : false,
            about: currentProfileAbout || "",
            profileImage: currentProfileImage || "",
            accountCreatedAt: currentAccountCreatedAt || "",
            studyTrack: studyTrack || "",
            selectedSubjects: typeof normalizeSelectedSubjects === "function"
                ? normalizeSelectedSubjects(studyTrack || "", selectedSubjects || [])
                : (selectedSubjects || []),
            schedule: scheduleData,
            totalWorkedSeconds: totalWorkedSecondsAllTime || 0,
            totalStudyTime: totalWorkedSecondsAllTime || 0,
            totalQuestionsAllTime: totalQuestionsAllTime || 0,
            activeTimer: activeSessionOverride === undefined ? (timerState.session ? serializeTimerSession(timerState.session) : null) : activeSessionOverride,
            isWorking: isTimerRecordRunning(activeSessionOverride === undefined ? timerState.session : activeSessionOverride),
            notes: typeof normalizeUserNotes === "function" ? normalizeUserNotes(userNotes || []) : []
        };
    }

    function refreshLeaderboardOptimistically(activeSessionOverride) {
        if (!currentUser) return;
        const docIndex = leaderboardRealtimeDocs.findIndex(item => item.id === currentUser.uid);
        const docData = buildOptimisticCurrentUserData(activeSessionOverride);

        if (docIndex >= 0) {
            leaderboardRealtimeDocs[docIndex] = { id: currentUser.uid, data: docData };
        } else {
            leaderboardRealtimeDocs.push({ id: currentUser.uid, data: docData });
        }

        if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
            renderLiveLeaderboardFromDocs();
        }
    }

    async function syncRealtimeTimer(reason = "manual", options = {}) {
        if (!currentUser || timerState.syncing) return;

        const shouldOwnTimer = !timerState.session?.isRunning || claimTimerOwnership();
        if (!shouldOwnTimer) return;

        timerState.syncing = true;

        try {
            if (timerState.session) {
                const delta = getPendingTimerDelta(timerState.session);
                if (delta > 0) {
                    applyStudyDelta(delta);
                    timerState.session.lastPersistedElapsedSeconds = getTimerElapsedSeconds(timerState.session);
                }
            }

            const activeSession = options.clearActive ? null : (options.activeSession === undefined ? timerState.session : options.activeSession);
            const payload = buildRealtimeStudyPayload({
                activeSession,
                currentSessionTime: options.currentSessionTime
            });

            await db.collection("users").doc(currentUser.uid).set(payload, { merge: true });
            persistTimerSessionLocally(activeSession);

            if (document.getElementById("leaderboard-panel")?.classList.contains("open")) {
                renderLiveLeaderboardFromDocs();
            }

            if (reason !== "interval") {
                renderSchedule();
            } else {
                updateLiveStudyPreview();
            }
        } catch (error) {
            console.error("Gercek zamanli sure senkronu basarisiz:", error);
        } finally {
            timerState.syncing = false;
        }
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
            todayNode.textContent = `⏱️ Bugün: ${typeof formatSeconds === "function" ? formatSeconds(currentDayWorked) : currentDayWorked}`;
        }

        if (weekNode) {
            weekNode.textContent = `🏆 Haftalık Süre: ${typeof formatSeconds === "function" ? formatSeconds(currentWeekTotals) : currentWeekTotals}`;
        }

        if (profileNode && document.getElementById("profile-modal")?.style.display === "flex" && currentProfileModalEditable) {
            profileNode.textContent = typeof formatSeconds === "function" ? formatSeconds((totalWorkedSecondsAllTime || 0) + unsavedDelta) : String((totalWorkedSecondsAllTime || 0) + unsavedDelta);
        }

        const todayCell = document.querySelector(".day-cell.active-today .day-score-display");
        if (todayCell) {
            todayCell.textContent = `⏱️ ${typeof formatSeconds === "function" ? formatSeconds(currentDayWorked) : currentDayWorked}`;
        }

        updateTimerSessionPill();
        refreshLeaderboardOptimistically();
    }

    function startOrResumeRealtimeTimer() {
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
        syncRealtimeTimer("start");
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
            currentSessionTime: 0
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
        timerState.session.targetDurationSeconds = getPomodoroInputSeconds() || 1500;
        timerDrafts.pomodoro = { ...timerState.session };
        persistTimerSessionLocally(null);
        releaseTimerOwnership();
        refreshLeaderboardOptimistically(null);
        renderTimerUi();
        safeShowAlert("Pomodoro oturumu tamamlandı. Süre otomatik kaydedildi.", "success");
    }

    async function resetRealtimeTimer(resetInputs = true, silent = false) {
        if (timerState.session) {
            const delta = getPendingTimerDelta(timerState.session);
            if (delta > 0) {
                applyStudyDelta(delta);
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
            if (minutes) minutes.value = 25;
            if (seconds) seconds.value = 0;
        }

        await syncRealtimeTimer("reset", {
            activeSession: null,
            currentSessionTime: 0,
            clearActive: true
        });

        timerState.session = createEmptyTimerSession(timerState.mode);
        if (timerState.mode === "pomodoro") {
            timerState.session.targetDurationSeconds = getPomodoroInputSeconds() || 1500;
        }
        timerDrafts[timerState.mode] = { ...timerState.session };

        refreshLeaderboardOptimistically(null);
        renderTimerUi();
        if (!silent) {
            safeShowAlert("Zamanlayıcı sıfırlandı.");
        }
    }

    function restoreTimerFromPersistence(userData = {}) {
        const stored = readStoredTimerSession();
        const dbSession = userData.activeTimer && userData.activeTimer.uid !== currentUser?.uid
            ? null
            : userData.activeTimer;

        const source = dbSession || stored;
        if (!source) {
            timerState.session = createEmptyTimerSession(timerState.mode);
            timerDrafts[timerState.mode] = { ...timerState.session };
            renderTimerUi();
            return;
        }

        timerState.mode = source.mode === "stopwatch" ? "stopwatch" : "pomodoro";
        timerState.session = {
            mode: timerState.mode,
            isRunning: !!source.isRunning,
            baseElapsedSeconds: Math.max(0, parseInteger(source.baseElapsedSeconds, 0)),
            lastPersistedElapsedSeconds: Math.max(0, parseInteger(source.lastPersistedElapsedSeconds, 0)),
            targetDurationSeconds: Math.max(0, parseInteger(source.targetDurationSeconds, 0)),
            startedAtMs: parseInteger(source.startedAtMs, 0)
        };

        setTimerMode(timerState.mode, { persist: false, keepSession: true });

        if (timerState.mode === "pomodoro" && !timerState.session.targetDurationSeconds) {
            timerState.session.targetDurationSeconds = getPomodoroInputSeconds() || 1500;
        }

        timerDrafts[timerState.mode] = { ...timerState.session };

        const shouldResume = timerState.session.isRunning && claimTimerOwnership();
        if (shouldResume) {
            startTimerLoops();
        } else {
            timerState.session.isRunning = false;
            timerState.session.startedAtMs = 0;
        }

        renderTimerUi();
    }

    function getLiveLeaderboardSeconds(userData) {
        const currentDate = new Date();
        const { weekKey, dayIdx } = getCurrentDayMeta(currentDate);
        let totalSeconds = 0;

        if (currentLeaderboardTab === "daily") {
            totalSeconds = parseInteger(userData?.schedule?.[weekKey]?.[dayIdx]?.workedSeconds, 0);
        } else if (userData?.schedule?.[weekKey]) {
            for (let i = 0; i < 7; i += 1) {
                totalSeconds += parseInteger(userData.schedule[weekKey]?.[i]?.workedSeconds, 0);
            }
        }

        const activeTimer = userData?.activeTimer;
        if (activeTimer?.isRunning) {
            const liveElapsed = getTimerElapsedSeconds(activeTimer, Date.now());
            const liveDelta = Math.max(0, liveElapsed - parseInteger(activeTimer.lastPersistedElapsedSeconds, 0));
            totalSeconds += liveDelta;
        }

        return totalSeconds;
    }

    function getLiveLeaderboardQuestions(userData) {
        const currentDate = new Date();
        const { weekKey, dayIdx } = getCurrentDayMeta(currentDate);
        let totalQuestions = 0;

        if (currentLeaderboardTab === "daily") {
            totalQuestions = parseInteger(userData?.schedule?.[weekKey]?.[dayIdx]?.questions, 0);
        } else if (userData?.schedule?.[weekKey]) {
            for (let i = 0; i < 7; i += 1) {
                totalQuestions += parseInteger(userData.schedule[weekKey]?.[i]?.questions, 0);
            }
        }

        return totalQuestions;
    }

    function buildLeaderboardViewModelFromDocs() {
        return leaderboardRealtimeDocs
            .map(doc => {
                const data = doc.data || {};
                const seconds = getLiveLeaderboardSeconds(data);
                const questions = getLiveLeaderboardQuestions(data);
                const currentWeekTotals = typeof getCurrentWeekTotalsFromSchedule === "function"
                    ? getCurrentWeekTotalsFromSchedule(data.schedule || {}).seconds
                    : seconds;
                const titleInfo = typeof getCurrentTitleInfoFromSeconds === "function"
                    ? getCurrentTitleInfoFromSeconds(currentWeekTotals)
                    : null;
                const resolvedIsAdmin = !!data.isAdmin || (typeof isAdminIdentity === "function" && isAdminIdentity(data.username || "", data.email || ""));

                const isWorking = currentLeaderboardTab === "daily" && isTimerRecordRunning(data.activeTimer);

                if (!data.username) return null;
                if (!(seconds > 0 || resolvedIsAdmin || isWorking)) return null;

                return {
                    uid: doc.id,
                    username: data.username,
                    email: data.email || "",
                    isAdmin: resolvedIsAdmin,
                    about: data.about || "",
                    profileImage: data.profileImage || "",
                    accountCreatedAt: data.accountCreatedAt || "",
                    studyTrack: data.studyTrack || "",
                    selectedSubjects: typeof normalizeSelectedSubjects === "function"
                        ? normalizeSelectedSubjects(data.studyTrack || "", data.selectedSubjects || [])
                        : (data.selectedSubjects || []),
                    currentWeekSeconds: currentWeekTotals,
                    titleInfo,
                    competitionScore: typeof getCompetitionScore === "function" ? getCompetitionScore(seconds, questions) : (seconds * 10) + questions,
                    seconds,
                    questions,
                    totalWorkedSeconds: Math.max(parseInteger(data.totalWorkedSeconds, 0), parseInteger(data.totalStudyTime, 0), typeof calculateTotalWorkedSecondsFromSchedule === "function" ? calculateTotalWorkedSecondsFromSchedule(data.schedule || {}) : 0),
                    totalQuestionsAllTime: parseInteger(data.totalQuestionsAllTime, 0),
                    isWorking,
                    notes: typeof getPublicUserNotes === "function" ? getPublicUserNotes(data.notes || []) : []
                };
            })
            .filter(Boolean)
            .sort((a, b) => (b.competitionScore - a.competitionScore) || (b.seconds - a.seconds) || (b.questions - a.questions));
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

            item.innerHTML = `
                <div class="leaderboard-rank">#${index + 1}</div>
                <img class="leaderboard-avatar" src="${escapeHtml(typeof getProfileImageSrc === "function" ? getProfileImageSrc(user.profileImage, user.username) : "")}" alt="${escapeHtml(user.username)}">
                <div class="leaderboard-name-wrapper">
                    <div class="leaderboard-name">${escapeHtml(user.username)}</div>
                    <div class="leaderboard-extra-badges">${adminBadgeHtml}${titleBadgeHtml}</div>
                </div>
                <div class="leaderboard-stats">
                    <div class="leaderboard-score">${typeof formatSeconds === "function" ? formatSeconds(user.seconds) : user.seconds}</div>
                    <div class="leaderboard-questions">🎯 ${user.questions} Soru</div>
                    ${user.isWorking ? '<div class="working-badge">Canlı</div>' : ""}
                </div>
            `;

            listContainer.appendChild(item);
        });
    }

    function subscribeRealtimeLeaderboard() {
        if (leaderboardRealtimeUnsubscribe) return;

        const listContainer = document.getElementById("leaderboard-list");
        if (listContainer) {
            listContainer.innerHTML = '<p style="text-align:center; opacity:0.7;">Canlı veriler yükleniyor...</p>';
        }

        leaderboardRealtimeUnsubscribe = db.collection("users").onSnapshot(snapshot => {
            leaderboardRealtimeDocs = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
            renderLiveLeaderboardFromDocs();
        }, error => {
            console.error("Canlı lider tablosu dinlenemedi:", error);
            if (listContainer) {
                listContainer.innerHTML = '<p style="text-align:center; color:#f87171;">Lider tablosu yüklenemedi.</p>';
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
        folderMap.set(NOTE_FOLDER_DEFAULT_ID, {
            id: NOTE_FOLDER_DEFAULT_ID,
            name: "Genel",
            createdAt: new Date().toISOString()
        });

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

        saveData();
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
                ? "Kronometre çalışıyor. Süre canlı olarak takip ediliyor."
                : "Pomodoro çalışıyor. Süre canlı olarak takip ediliyor.");
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

    function normalizeTaskQuestionMap(dayData) {
        const taskOptions = getDayQuestionSubjectOptions(dayData);
        const rawMap = normalizeSubjectQuestionMap(dayData?.subjectQuestions || {});
        if (!taskOptions.length) return rawMap;

        const optionSet = new Set(taskOptions);
        const nextMap = {};
        let legacyTotal = 0;

        Object.entries(rawMap).forEach(([key, amount]) => {
            const normalizedAmount = clampNumber(amount, 0, QUESTION_LIMIT);
            if (normalizedAmount <= 0) return;
            if (optionSet.has(key)) {
                nextMap[key] = normalizedAmount;
            } else {
                legacyTotal += normalizedAmount;
            }
        });

        if (legacyTotal > 0) {
            const primaryKey = taskOptions[0];
            nextMap[primaryKey] = clampNumber((nextMap[primaryKey] || 0) + legacyTotal, 0, QUESTION_LIMIT);
        }

        return normalizeSubjectQuestionMap(nextMap);
    }

    function syncDayQuestionState(dayData) {
        if (!dayData || typeof dayData !== "object") return dayData;
        dayData.subjectQuestions = normalizeTaskQuestionMap(dayData);
        dayData.questions = Object.values(dayData.subjectQuestions || {}).reduce((sum, amount) => sum + parseInteger(amount, 0), 0);
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
        const taskOptions = getDayQuestionSubjectOptions(dayData);
        if (!taskOptions.length) return "";
        return taskOptions.includes(currentValue) ? currentValue : taskOptions[0];
    }

    function getTaskQuestionSummaryHtml(dayData, taskOptions) {
        if (!taskOptions.length) {
            return '<span class="subject-question-empty">Önce görev ekleyin, sonra soru ekleyin.</span>';
        }

        const taskQuestionMap = normalizeTaskQuestionMap(dayData);
        const solvedEntries = taskOptions
            .map(taskLabel => ({
                taskLabel,
                amount: parseInteger(taskQuestionMap[taskLabel], 0)
            }))
            .filter(entry => entry.amount > 0);

        if (!solvedEntries.length) {
            return '<span class="subject-question-empty">Henüz görev bazlı soru kaydı eklenmedi.</span>';
        }

        return solvedEntries.map(({ taskLabel, amount }) => `
            <span class="subject-question-pill">
                ${escapeHtml(taskLabel)}
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
            const taskOptions = getDayQuestionSubjectOptions(dayData);
            const buttonGroup = input.closest(".question-input-box")?.querySelector(".question-btn-group");
            const summaryRoot = input.closest(".question-input-box");
            const questionRow = input.closest(".question-input-row");

            buttonGroup?.querySelector(".subject-breakdown-btn")?.remove();

            if (questionRow) {
                let select = questionRow.querySelector(".question-subject-select");
                if (!select) {
                    select = document.createElement("select");
                    select.className = "question-subject-select";
                    select.id = `q-subject-${dayIdx}`;
                }
                questionRow.appendChild(select);

                const selectedValue = select.value;
                if (taskOptions.length) {
                    select.innerHTML = taskOptions.map(taskLabel => `
                        <option value="${escapeHtml(taskLabel)}">${escapeHtml(taskLabel)}</option>
                    `).join("");
                    select.disabled = false;
                    select.value = getSafeSelectedTask(dayData, selectedValue);
                } else {
                    select.innerHTML = '<option value="">Önce görev ekleyin</option>';
                    select.disabled = true;
                }
            }

            let summary = summaryRoot?.querySelector(".subject-question-summary");
            if (!summary && summaryRoot) {
                summary = document.createElement("div");
                summary.className = "subject-question-summary";
                summaryRoot.appendChild(summary);
            }

            if (summary) {
                summary.innerHTML = getTaskQuestionSummaryHtml(dayData, taskOptions);
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

            item.innerHTML = `
                <div class="leaderboard-rank">#${index + 1}</div>
                <img class="leaderboard-avatar" src="${escapeHtml(typeof getProfileImageSrc === "function" ? getProfileImageSrc(user.profileImage, user.username) : "")}" alt="${escapeHtml(user.username)}">
                <div class="leaderboard-name-wrapper">
                    <div class="leaderboard-name">${escapeHtml(user.username)}</div>
                    <div class="leaderboard-extra-badges">${adminBadgeHtml}${titleBadgeHtml}</div>
                </div>
                <div class="leaderboard-stats">
                    <div class="leaderboard-score">${typeof formatSeconds === "function" ? formatSeconds(user.seconds) : user.seconds}</div>
                    <div class="leaderboard-questions">🎯 ${user.questions} Soru</div>
                    ${user.isWorking ? '<div class="working-badge">Çalışıyor</div>' : ""}
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
            safeShowAlert(`${taskLabel} için soru sayısı ${value} olarak kaydedildi.`, "success");
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

    function bootstrapExtendedUserData(userData = {}) {
        noteFolders = normalizeNoteFolders(userData.noteFolders || []);
        userNotes = normalizeUserNotes(userData.notes || userNotes || []);
        scheduleData = sanitizeScheduleData(userData.schedule || scheduleData || {});
        totalWorkedSecondsAllTime = Math.max(parseInteger(userData.totalWorkedSeconds, 0), parseInteger(userData.totalStudyTime, 0), typeof calculateTotalWorkedSecondsFromSchedule === "function" ? calculateTotalWorkedSecondsFromSchedule(scheduleData) : 0);
        totalQuestionsAllTime = Math.max(parseInteger(userData.totalQuestionsAllTime, 0), typeof calculateTotalQuestionsFromSchedule === "function" ? calculateTotalQuestionsFromSchedule(scheduleData) : 0);
        renderNoteFolderControls();
        restoreTimerFromPersistence(userData);
        updateLiveStudyPreview();
    }

    function patchProfileCopy() {
        if (typeof renderProfileTitles === "function") {
            renderProfileTitles = function(profileData) {
                const list = document.getElementById("profile-titles-list");
                const hint = document.getElementById("profile-titles-hint");
                const label = document.getElementById("profile-titles-label");
                if (!list || !hint || !label) return;

                const titleInfo = profileData?.titleInfo
                    || (typeof getCurrentTitleInfoFromSeconds === "function"
                        ? getCurrentTitleInfoFromSeconds(profileData?.currentWeekSeconds || 0)
                        : { unlockedTitles: [], currentTitle: null });
                const unlockedTitles = titleInfo.unlockedTitles || [];
                const currentTitleId = titleInfo.currentTitle?.id || "";
                const profileName = profileData?.username || "Bu kullanıcı";

                label.innerText = "Ünvanlar";
                hint.innerText = unlockedTitles.length
                    ? `${profileName} için açılan ${unlockedTitles.length} ünvan listeleniyor.`
                    : `${profileName} henüz ünvan açmadı.`;

                if (!unlockedTitles.length) {
                    list.innerHTML = '<div class="profile-notes-empty">Henüz açılan ünvan bulunmuyor.</div>';
                    return;
                }

                list.innerHTML = unlockedTitles.map(level => `
                    <article class="profile-title-card ${level.id === currentTitleId ? "current" : ""}">
                        <div class="title-inline-row">
                            <span class="title-badge ${level.className}"><span>${level.icon}</span><span>${level.label}</span></span>
                            ${level.id === currentTitleId ? '<span class="profile-title-current-pill"><i class="fas fa-star"></i> Aktif Ünvan</span>' : ""}
                        </div>
                        <p><strong>${level.requirement}</strong><br>${level.description}</p>
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
            showProfileModal = function(...args) {
                const result = originalShowProfileModal.apply(this, args);
                const titleWrapper = document.getElementById("profile-title-wrapper");
                if (titleWrapper) {
                    titleWrapper.innerHTML = titleWrapper.innerHTML
                        .replace(/Haftalik gunluk ortalama/gi, "Haftalık günlük ortalama")
                        .replace(/Aktif Unvan/gi, "Aktif Ünvan");
                }
                const titlesLabel = document.getElementById("profile-titles-label");
                if (titlesLabel) titlesLabel.innerText = "Ünvanlar";
                return result;
            };
        }
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
                    await db.collection("users").doc(credential.user.uid).set(createSignupPayload(username, email, accountCreatedAt), { merge: true });
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
            const dayData = ensureWeekDay(weekKey, dayIdx);
            const subjectId = select?.value || getDayQuestionSubjectOptions(dayData)[0] || "";
            if (!subjectId) {
                setQuestionValidation(dayIdx, "Önce görev eklemelisiniz");
                safeShowAlert("Önce görev ekleyin, sonra soru girin.");
                return;
            }

            const otherQuestionsTotal = Object.entries(dayData.subjectQuestions || {})
                .filter(([id]) => id !== subjectId)
                .reduce((sum, [, amount]) => sum + parseInteger(amount, 0), 0);

            if ((otherQuestionsTotal + value) > QUESTION_LIMIT) {
                setQuestionValidation(dayIdx, getQuestionLimitError());
                safeShowAlert(getQuestionLimitError());
                return;
            }

            dayData.subjectQuestions = normalizeSubjectQuestionMap(dayData.subjectQuestions || {});
            dayData.subjectQuestions[subjectId] = value;
            dayData.questions = Object.values(dayData.subjectQuestions).reduce((sum, amount) => sum + amount, 0);

            saveData();
            input.value = "";
            setQuestionValidation(dayIdx, "");
            renderSchedule();
            safeShowAlert(`${subjectId} için soru sayısı ${value} olarak kaydedildi.`, "success");
        };

        clearQuestions = function(dayIdx) {
            const weekKey = getWeekKey(currentWeekStart);
            const dayData = ensureWeekDay(weekKey, dayIdx);
            const select = document.getElementById(`q-subject-${dayIdx}`);
            const subjectId = select?.value || getDayQuestionSubjectOptions(dayData)[0] || FREE_GENERAL_SUBJECT;
            dayData.subjectQuestions = normalizeSubjectQuestionMap(dayData.subjectQuestions || {});

            if (dayData.subjectQuestions[subjectId]) {
                delete dayData.subjectQuestions[subjectId];
            } else {
                dayData.subjectQuestions = {};
            }

            dayData.questions = Object.values(dayData.subjectQuestions).reduce((sum, amount) => sum + amount, 0);
            saveData();
            renderSchedule();
        };
    }

    function patchTimerControls() {
        toggleTimer = function() {
            if (timerState.session?.isRunning) {
                pauseRealtimeTimer();
            } else {
                startOrResumeRealtimeTimer();
            }
        };

        updateTimerFromInputsAndReset = function() {
            if (timerState.session?.isRunning) return;

            if (timerState.mode === "pomodoro") {
                const totalSeconds = getPomodoroInputSeconds();
                timerState.session = createEmptyTimerSession("pomodoro");
                timerState.session.targetDurationSeconds = totalSeconds || 1500;
            } else {
                timerState.session = createEmptyTimerSession("stopwatch");
            }

            renderTimerUi();
        };

        resetTimer = function(_stop, resetInputs) {
            resetRealtimeTimer(resetInputs !== false);
        };

        saveWorkSession = function() {
            syncRealtimeTimer("manual-save");
            safeShowAlert("Süre kaydedildi. Sayaç arka planda çalışmaya devam edebilir.", "success");
            hidePomodoroModal();
        };

        checkActiveTimer = function() {
            renderTimerUi();
        };

        showPomodoroModal = (function(originalShowPomodoroModal) {
            return function() {
                if (guardVerifiedAccess()) return;
                if (typeof originalShowPomodoroModal === "function") {
                    originalShowPomodoroModal();
                } else {
                    document.getElementById("pomodoro-modal").style.display = "flex";
                }
                ensureTimerModeUi();
                setTimerMode(timerState.mode, { persist: false, keepSession: true });
                renderTimerUi();
                if (typeof syncBodyModalLock === "function") syncBodyModalLock();
            };
        })(typeof showPomodoroModal === "function" ? showPomodoroModal : null);

        hidePomodoroModal = (function(originalHidePomodoroModal) {
            return function() {
                syncRealtimeTimer("modal-hide");
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
                unsubscribeRealtimeLeaderboard();
                return;
            }

            panel.classList.add("open");
            subscribeRealtimeLeaderboard();
        };

        switchLeaderboardTab = function(tab) {
            currentLeaderboardTab = tab === "weekly" ? "weekly" : "daily";
            document.getElementById("tab-daily")?.classList.toggle("active", currentLeaderboardTab === "daily");
            document.getElementById("tab-weekly")?.classList.toggle("active", currentLeaderboardTab === "weekly");
            renderLiveLeaderboardFromDocs();
        };

        fetchAndRenderLeaderboard = function() {
            subscribeRealtimeLeaderboard();
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
            return {
                ...basePayload,
                email: currentUser?.email || basePayload.email || "",
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
                totalQuestionsAllTime: totalQuestionsAllTime || 0,
                dailyStudyTime: getCurrentDayWorkedSeconds(),
                currentSessionTime: timerState.session?.isRunning ? getTimerElapsedSeconds(timerState.session) : 0,
                activeTimer: timerState.session ? serializeTimerSession(timerState.session) : null,
                isWorking: isTimerRecordRunning(timerState.session),
                lastTimerSyncAt: Date.now()
            };
        };

        if (typeof getCurrentUserSeedData === "function") {
            const originalGetCurrentUserSeedData = getCurrentUserSeedData;
            getCurrentUserSeedData = function() {
                const seed = originalGetCurrentUserSeedData();
                return {
                    ...seed,
                    noteFolders: normalizeNoteFolders(noteFolders),
                    totalStudyTime: totalWorkedSecondsAllTime || 0,
                    dailyStudyTime: getCurrentDayWorkedSeconds(),
                    currentSessionTime: timerState.session?.isRunning ? getTimerElapsedSeconds(timerState.session) : 0,
                    activeTimer: timerState.session ? serializeTimerSession(timerState.session) : null,
                    emailVerified: !!currentUser?.emailVerified
                };
            };
        }
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
            renderQuestionTrackingEnhancements();
            updateLiveStudyPreview();
        };
    }

    function attachRealtimeListeners() {
        auth.onAuthStateChanged(async user => {
            ensureVerificationCard();
            applyTurkishInputSupport();

            if (!user) {
                currentUser = null;
                requiresEmailVerification = false;
                noteFolders = normalizeNoteFolders([]);
                activeNoteFolderId = NOTE_FOLDER_ALL_ID;
                unsubscribeRealtimeLeaderboard();
                stopTimerLoops();
                timerState.session = null;
                persistTimerSessionLocally(null);
                releaseTimerOwnership();
                hideVerificationGate();
                renderTimerUi();
                return;
            }

            currentUser = user;
            localStorage.setItem(VERIFY_EMAIL_KEY, user.email || "");

            try {
                await user.reload();
                await updateEmailVerificationField(user);
            } catch (error) {
                console.error("Kullanici yenilenemedi:", error);
            }

            hideVerificationGate();

            db.collection("users").doc(user.uid).get().then(doc => {
                const data = doc.exists ? (doc.data() || {}) : {};
                requiresEmailVerification = !!data.requiresEmailVerification;
                if (requiresEmailVerification && !user.emailVerified) {
                    showVerificationGate({
                        email: user.email || "",
                        meta: "Bu yeni hesap için email doğrulaması bekleniyor."
                    });
                } else {
                    requiresEmailVerification = false;
                    hideVerificationGate();
                }
                bootstrapExtendedUserData(data);
                renderSchedule();
                renderMyNotesPanel();
            }).catch(error => {
                console.error("Genişletilmiş kullanıcı verisi okunamadi:", error);
            });
        });

        document.addEventListener("visibilitychange", () => {
            if (document.hidden && timerState.session?.isRunning) {
                syncRealtimeTimer("visibility-hidden");
            }
        });

        window.addEventListener("beforeunload", () => {
            if (timerState.session?.isRunning) {
                persistTimerSessionLocally(timerState.session);
            }
            releaseTimerOwnership();
        });
    }

    function initUpgradeLayer() {
        ensureVerificationCard();
        ensureTimerModeUi();
        ensureSubjectQuestionModal();
        ensureNavyThemeButton();
        ensureNotesFolderUi();
        applyTurkishInputSupport();
        refreshVerificationCooldownUI();

        patchPersistenceLayer();
        patchAuthFlows();
        patchQuestionTracking();
        patchTaskInteractions();
        patchNotesFolders();
        patchTimerControls();
        patchProfileCopy();
        patchLeaderboardRealtime();
        patchProtectedOpeners();
        patchRenderSchedule();
        attachRealtimeListeners();

        setTimerMode(timerState.mode, { persist: false, keepSession: true });
        if (!timerState.session) {
            timerState.session = createEmptyTimerSession(timerState.mode);
            if (timerState.mode === "pomodoro") {
                timerState.session.targetDurationSeconds = getPomodoroInputSeconds() || 1500;
            }
        }
        renderTimerUi();
        renderQuestionTrackingEnhancements();
        renderNoteFolderControls();
        observeTimerOwnership();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initUpgradeLayer);
    } else {
        initUpgradeLayer();
    }
})();
