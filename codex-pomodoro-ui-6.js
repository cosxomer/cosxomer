(() => {
    function getTimerParts(totalSeconds) {
        const safeSeconds = Math.max(0, Number.isFinite(totalSeconds) ? Math.floor(totalSeconds) : 0);
        return {
            hours: Math.floor(safeSeconds / 3600),
            minutes: Math.floor((safeSeconds % 3600) / 60),
            seconds: safeSeconds % 60
        };
    }

    function formatTimerValue(value) {
        return String(Math.max(0, value)).padStart(2, '0');
    }

    function parseTimerDisplayText(displayText) {
        const parts = String(displayText || '').trim().split(':').map(part => parseInt(part, 10));
        if (parts.length !== 3 || parts.some(part => Number.isNaN(part))) {
            return { hours: 0, minutes: 25, seconds: 0 };
        }

        return {
            hours: parts[0],
            minutes: parts[1],
            seconds: parts[2]
        };
    }

    function ensureSegmentedTimerDisplay() {
        const timerDisplay = document.getElementById('timer-display');
        if (!timerDisplay) return null;

        if (!timerDisplay.dataset.segmentedPomodoro) {
            timerDisplay.dataset.segmentedPomodoro = 'true';
            timerDisplay.setAttribute('role', 'timer');
            timerDisplay.setAttribute('aria-live', 'polite');
            timerDisplay.setAttribute('aria-label', 'Pomodoro sayaci');
            timerDisplay.innerHTML = [
                '<span class="timer-display__group" data-unit="hours">',
                '  <span class="timer-display__value" data-part="hours">00</span>',
                '</span>',
                '<span class="timer-display__separator" aria-hidden="true">:</span>',
                '<span class="timer-display__group" data-unit="minutes">',
                '  <span class="timer-display__value" data-part="minutes">25</span>',
                '</span>',
                '<span class="timer-display__separator" aria-hidden="true">:</span>',
                '<span class="timer-display__group" data-unit="seconds">',
                '  <span class="timer-display__value" data-part="seconds">00</span>',
                '</span>'
            ].join('');
        }

        return timerDisplay;
    }

    function renderSegmentedTimerDisplay(totalSeconds) {
        const timerDisplay = ensureSegmentedTimerDisplay();
        if (!timerDisplay) return;

        const parts = Number.isFinite(totalSeconds)
            ? getTimerParts(totalSeconds)
            : parseTimerDisplayText(timerDisplay.innerText);

        const hoursNode = timerDisplay.querySelector('[data-part="hours"]');
        const minutesNode = timerDisplay.querySelector('[data-part="minutes"]');
        const secondsNode = timerDisplay.querySelector('[data-part="seconds"]');

        if (hoursNode) hoursNode.textContent = formatTimerValue(parts.hours);
        if (minutesNode) minutesNode.textContent = formatTimerValue(parts.minutes);
        if (secondsNode) secondsNode.textContent = formatTimerValue(parts.seconds);
    }

    updateTimerDisplay = function() {
        const totalSeconds = typeof timeRemaining === 'number' ? timeRemaining : NaN;
        renderSegmentedTimerDisplay(totalSeconds);
    };

    const originalShowPomodoroModal = typeof showPomodoroModal === 'function' ? showPomodoroModal : null;
    if (originalShowPomodoroModal) {
        showPomodoroModal = function() {
            originalShowPomodoroModal();
            renderSegmentedTimerDisplay(typeof timeRemaining === 'number' ? timeRemaining : NaN);
        };
    }

    window.addEventListener('load', () => {
        renderSegmentedTimerDisplay(typeof timeRemaining === 'number' ? timeRemaining : NaN);
    });
})();
