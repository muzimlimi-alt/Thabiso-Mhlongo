/**
 * THABISO MHLONGO — NOTIFICATION SERVICE v2.0
 * Centralised singleton: toasts, modals, HTTP error overlays, ARIA/WCAG compliance.
 */

class NotificationService {
    constructor() {
        this.toastContainer = null;
        this.modalRoot      = null;
        this.httpErrorRoot  = null;
        this.liveRegion     = null;
        this.isInitialized  = false;
        this._queue         = [];
        this._activeToasts  = 0;
        this._MAX_TOASTS    = 5;
        this._previousFocus = null;
    }

    _initialize() {
        if (this.isInitialized) return;

        this.toastContainer = document.createElement('div');
        this.toastContainer.id = 'tm-toast-container';
        this.toastContainer.setAttribute('aria-label', 'Notifications');
        document.body.appendChild(this.toastContainer);

        this.modalRoot = document.createElement('div');
        this.modalRoot.id = 'tm-modal-root';
        document.body.appendChild(this.modalRoot);

        this.httpErrorRoot = document.createElement('div');
        this.httpErrorRoot.id = 'tm-http-error-root';
        document.body.appendChild(this.httpErrorRoot);

        // Screen-reader live region for toast announcements
        this.liveRegion = document.createElement('div');
        this.liveRegion.id = 'tm-live-region';
        this.liveRegion.className = 'tm-sr-only';
        this.liveRegion.setAttribute('aria-live', 'polite');
        this.liveRegion.setAttribute('aria-atomic', 'true');
        document.body.appendChild(this.liveRegion);

        this.isInitialized = true;
    }

    _announce(text, urgent) {
        if (!this.liveRegion) return;
        this.liveRegion.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
        this.liveRegion.textContent = '';
        requestAnimationFrame(() => { this.liveRegion.textContent = text; });
    }

    // NOTIF-XSS: toast/modal/http-error bodies are built via innerHTML, and messages can carry
    // user- or server-reflected data (e.g. the global fetch interceptor auto-shows data.message
    // from any failed API response). Escape all interpolated text so a message can never inject
    // markup into the admin's DOM. Callers pass plain text only (verified), so this is loss-free.
    _escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ─── Toast ───────────────────────────────────────────────────────────────

    _showToast(type, message, opts) {
        this._initialize();
        const { title = '', duration = 5000 } = (opts || {});

        if (this._activeToasts >= this._MAX_TOASTS) {
            this._queue.push({ type, message, opts });
            return;
        }
        this._activeToasts++;

        const icons = {
            error:   'fa-solid fa-circle-exclamation',
            success: 'fa-solid fa-circle-check',
            warning: 'fa-solid fa-triangle-exclamation',
            info:    'fa-solid fa-circle-info'
        };
        const defaultTitles = {
            error:   'Action Failed',
            success: 'Success',
            warning: 'Attention Required',
            info:    'Information'
        };

        const toastTitle = title || defaultTitles[type];

        const toast = document.createElement('div');
        toast.className = `tm-toast tm-toast--${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.setAttribute('aria-atomic', 'true');
        toast.setAttribute('tabindex', '0');
        if (duration > 0) toast.style.setProperty('--tm-duration', duration + 'ms');

        toast.innerHTML = `
            <div class="tm-toast__progress" aria-hidden="true"></div>
            <div class="tm-toast__icon" aria-hidden="true"><i class="${icons[type]}"></i></div>
            <div class="tm-toast__content">
                <span class="tm-toast__title">${this._escape(toastTitle)}</span>
                <p class="tm-toast__message">${this._escape(message)}</p>
            </div>
            <button class="tm-toast__close" aria-label="Dismiss notification" type="button">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
        `;

        toast.querySelector('.tm-toast__close').addEventListener('click', () => this._dismissToast(toast));
        toast.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'Delete') this._dismissToast(toast);
        });

        this.toastContainer.appendChild(toast);
        this._announce(toastTitle + ': ' + message, type === 'error');

        if (duration > 0) setTimeout(() => this._dismissToast(toast), duration);
    }

    _dismissToast(toast) {
        if (!toast || !toast.parentNode) return;
        toast.classList.add('exiting');
        toast.addEventListener('animationend', () => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
            this._activeToasts = Math.max(0, this._activeToasts - 1);
            if (this._queue.length > 0) {
                const next = this._queue.shift();
                this._showToast(next.type, next.message, next.opts);
            }
        }, { once: true });
    }

    // Supports both showError(message) and showError(title, message)
    showError(msgOrTitle, optsOrMsg)   { this._dispatchToast('error',   msgOrTitle, optsOrMsg); }
    showSuccess(msgOrTitle, optsOrMsg) { this._dispatchToast('success', msgOrTitle, optsOrMsg); }
    showWarning(msgOrTitle, optsOrMsg) { this._dispatchToast('warning', msgOrTitle, optsOrMsg); }
    showInfo(msgOrTitle, optsOrMsg)    { this._dispatchToast('info',    msgOrTitle, optsOrMsg); }

    _dispatchToast(type, msgOrTitle, optsOrMsg) {
        if (typeof optsOrMsg === 'string') {
            // showError('Title', 'Body') calling style
            this._showToast(type, optsOrMsg, { title: msgOrTitle });
        } else {
            this._showToast(type, msgOrTitle, optsOrMsg);
        }
    }

    // ─── Modal ───────────────────────────────────────────────────────────────

    _showModal(options) {
        this._initialize();
        const {
            type          = 'info',
            title         = 'Confirm Action',
            message       = '',
            confirmText   = 'Confirm',
            cancelText    = 'Cancel',
            isDestructive = false,
            isPrompt      = false,
            isAlert       = false,
            placeholder   = '',
            defaultValue  = ''
        } = (options || {});

        this._previousFocus = document.activeElement;

        const iconMap = {
            error:   'fa-solid fa-circle-xmark',
            warning: 'fa-solid fa-triangle-exclamation',
            success: 'fa-solid fa-circle-check',
            info:    'fa-solid fa-circle-info',
            confirm: 'fa-solid fa-circle-question'
        };

        return new Promise((resolve) => {
            this.modalRoot.innerHTML = `
                <div class="tm-modal-backdrop" aria-hidden="true"></div>
                <div class="tm-modal-container" role="dialog" aria-modal="true"
                     aria-labelledby="tm-modal-title" aria-describedby="tm-modal-desc">
                    <div class="tm-modal__header">
                        <i class="tm-modal__icon ${iconMap[type] || iconMap.info}" aria-hidden="true"></i>
                        <h2 class="tm-modal__title" id="tm-modal-title">${this._escape(title)}</h2>
                    </div>
                    <div class="tm-modal__body" id="tm-modal-desc">
                        <p>${this._escape(message)}</p>
                        ${isPrompt ? `
                            <div class="tm-modal__input-wrap">
                                <label for="tm-modal-input" class="tm-sr-only">Input</label>
                                <input type="text" class="tm-modal__input" id="tm-modal-input"
                                       placeholder="${this._escape(placeholder)}" value="${this._escape(defaultValue)}" autocomplete="off">
                            </div>
                        ` : ''}
                    </div>
                    <div class="tm-modal__footer">
                        ${!isAlert ? `<button class="tm-modal__btn tm-modal__btn--secondary" id="tm-modal-cancel" type="button">${cancelText}</button>` : ''}
                        <button class="tm-modal__btn ${isDestructive ? 'tm-modal__btn--danger' : 'tm-modal__btn--primary'}"
                                id="tm-modal-confirm" type="button">${confirmText}</button>
                    </div>
                </div>
            `;

            this.modalRoot.classList.add('is-active');
            document.body.style.overflow = 'hidden';

            const container  = this.modalRoot.querySelector('.tm-modal-container');
            const cancelBtn  = this.modalRoot.querySelector('#tm-modal-cancel');
            const confirmBtn = this.modalRoot.querySelector('#tm-modal-confirm');
            const input      = this.modalRoot.querySelector('#tm-modal-input');

            requestAnimationFrame(() => { (input || confirmBtn).focus(); });

            // Focus trap
            const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
            const trapFocus = (e) => {
                if (e.key !== 'Tab') return;
                const nodes = Array.from(container.querySelectorAll(FOCUSABLE));
                const first = nodes[0], last = nodes[nodes.length - 1];
                if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
                else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
            };
            document.addEventListener('keydown', trapFocus);

            const closeModal = (result) => {
                document.removeEventListener('keydown', trapFocus);
                document.removeEventListener('keydown', handleKey);
                this.modalRoot.classList.remove('is-active');
                document.body.style.overflow = '';
                try { if (this._previousFocus) this._previousFocus.focus(); } catch (_) {}
                this._previousFocus = null;
                resolve(result);
            };

            if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal(isPrompt ? null : false));
            confirmBtn.addEventListener('click', () => closeModal(isPrompt ? (input ? input.value : '') : (isAlert ? undefined : true)));

            // Backdrop click — only for non-destructive modals
            this.modalRoot.querySelector('.tm-modal-backdrop').addEventListener('click', () => {
                if (!isDestructive) closeModal(isPrompt ? null : false);
            });

            const handleKey = (e) => {
                if (e.key === 'Escape' && !isDestructive) { e.preventDefault(); closeModal(isPrompt ? null : false); }
                if (e.key === 'Enter' && !isPrompt && !isAlert) { e.preventDefault(); closeModal(true); }
            };
            document.addEventListener('keydown', handleKey);
        });
    }

    showConfirm(options) {
        return this._showModal({ type: 'confirm', confirmText: 'Confirm', cancelText: 'Cancel', ...options });
    }

    showPrompt(options) {
        return this._showModal({ type: 'info', isPrompt: true, confirmText: 'Submit', cancelText: 'Cancel', ...options });
    }

    // Single-button informational modal (replaces native alert())
    showAlert(options) {
        return this._showModal({ isAlert: true, confirmText: 'OK', type: 'info', ...options });
    }

    // ─── HTTP Error Overlay ───────────────────────────────────────────────────

    showHttpError(code, options) {
        this._initialize();
        const defaults = {
            400: {
                icon: 'fa-solid fa-triangle-exclamation',
                title: 'Bad Request',
                message: 'The server could not understand this request. Please check your input and try again.',
                actions: []
            },
            401: {
                icon: 'fa-solid fa-lock',
                title: 'Unauthorised',
                message: 'You need to sign in to access this resource. Please log in and try again.',
                actions: [{ label: 'Sign In', href: '/admin.html', primary: true }]
            },
            403: {
                icon: 'fa-solid fa-ban',
                title: 'Access Forbidden',
                message: "You don't have permission to view this. Contact your administrator if you believe this is an error.",
                actions: []
            },
            404: {
                icon: 'fa-solid fa-microphone-slash',
                title: 'Page Not Found',
                message: "The page you're looking for has left the building. It may have been moved, renamed, or removed.",
                actions: []
            },
            500: {
                icon: 'fa-solid fa-server',
                title: 'Server Error',
                message: 'Something went wrong on our end. Our team has been notified. Please try again shortly.',
                actions: []
            }
        };

        const cfg = Object.assign({}, defaults[code] || defaults[500], options || {});

        const actionBtns = cfg.actions.map(a =>
            `<a href="${this._escape(a.href)}" class="tm-http-error__btn ${a.primary ? 'tm-http-error__btn--primary' : 'tm-http-error__btn--secondary'}">${this._escape(a.label)}</a>`
        ).join('');

        this.httpErrorRoot.innerHTML = `
            <div class="tm-http-error" role="alertdialog" aria-modal="true"
                 aria-labelledby="tm-http-title" aria-describedby="tm-http-desc">
                <div class="tm-http-error__inner">
                    <div class="tm-http-error__icon" aria-hidden="true"><i class="${cfg.icon}"></i></div>
                    ${code ? `<div class="tm-http-error__code" aria-hidden="true">${code}</div>` : ''}
                    <h1 class="tm-http-error__title" id="tm-http-title">${this._escape(cfg.title)}</h1>
                    <p class="tm-http-error__message" id="tm-http-desc">${this._escape(cfg.message)}</p>
                    <div class="tm-http-error__actions">
                        <button class="tm-http-error__btn tm-http-error__btn--secondary"
                                type="button" onclick="history.back()">
                            <i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Go Back
                        </button>
                        <a href="/" class="tm-http-error__btn tm-http-error__btn--primary">
                            <i class="fa-solid fa-house" aria-hidden="true"></i> Return Home
                        </a>
                        ${actionBtns}
                    </div>
                </div>
            </div>
        `;
        this.httpErrorRoot.classList.add('is-active');
        document.body.style.overflow = 'hidden';

        // Focus first button
        requestAnimationFrame(() => {
            const btn = this.httpErrorRoot.querySelector('button, a');
            if (btn) btn.focus();
        });
    }

    // ─── API Fetch Helper ─────────────────────────────────────────────────────

    async apiFetch(url, options) {
        try {
            const res = await fetch(url, options || {});
            if (res.status === 401) { this.showHttpError(401); return null; }
            if (res.status === 403) { this.showHttpError(403); return null; }
            if (res.status === 404) { this.showHttpError(404); return null; }
            if (!res.ok) {
                let data = null;
                try { data = await res.clone().json(); } catch (_) {}
                this.showError((data && data.message) || ('Server returned ' + res.status));
                return null;
            }
            return res;
        } catch (e) {
            this.showError('Could not connect to the server. Please check your connection.');
            return null;
        }
    }
    // ─── Global Error Interceptors ────────────────────────────────────────────

    setupGlobalInterceptors() {
        if (this._interceptorsSetup) return;
        this._interceptorsSetup = true;

        const self = this;

        // Friendly error messages mapping for end-users
        const getFriendlyErrorMessage = (status) => {
            const errors = {
                0: "Network Error: Could not connect to the server. Please check your internet connection.",
                400: "The request was invalid. Please check your inputs and try again.",
                401: "Your session has expired. Please sign in to continue.",
                403: "Access denied. You do not have permission to perform this action.",
                404: "The requested resource could not be found.",
                408: "The server took too long to respond. Please try again.",
                429: "Too many requests. Please wait a few minutes before trying again.",
                500: "Something went wrong on our end. Please try again in a few moments.",
                502: "Bad gateway. The server is currently unreachable.",
                503: "Service temporarily unavailable. We are performing maintenance.",
                504: "Gateway timeout. Please check your connection and try again."
            };
            return errors[status] || `Request failed (Error ${status}). Please try again.`;
        };

        // Helper to extract URL and determine if it should bypass overlays/toasts
        const checkUrl = (urlStr) => {
            const url = String(urlStr || '');
            const isApi = url.includes('/api/') || url.startsWith('api/');
            const isSessionOrDebug = url.includes('/session') || url.includes('/debug') || url.includes('/login') || url.includes('/logout');
            return { isApi, isSessionOrDebug };
        };

        // 1. Intercept Fetch
        const originalFetch = window.fetch;

        // Fetch with Retry mechanism for GET requests
        const fetchWithRetry = async (urlOrRequest, initOptions = {}, retries = 3, delay = 1000) => {
            let urlVal = '';
            if (urlOrRequest) {
                if (typeof urlOrRequest === 'string') {
                    urlVal = urlOrRequest;
                } else if (typeof urlOrRequest === 'object') {
                    urlVal = urlOrRequest.url || urlOrRequest.href || String(urlOrRequest);
                }
            }
            const method = (initOptions && initOptions.method) || (urlOrRequest && urlOrRequest.method) || 'GET';
            const isGet = method.toUpperCase() === 'GET';
            const shouldRetry = isGet && (!initOptions || initOptions.retry !== false);

            try {
                const res = await originalFetch(urlOrRequest, initOptions);
                if (res.ok || !shouldRetry || res.status === 401 || res.status === 403 || res.status === 404) {
                    return res;
                }
                // Retry on network errors or 5xx/503 statuses
                if (res.status >= 500 || res.status === 408) {
                    if (retries > 0) {
                        console.warn(`[Fetch Retry] Retrying request to ${urlVal}. Retries left: ${retries}. Status: ${res.status}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        return fetchWithRetry(urlOrRequest, initOptions, retries - 1, delay * 2);
                    }
                }
                return res;
            } catch (err) {
                if (shouldRetry && retries > 0) {
                    console.warn(`[Fetch Retry] Retrying request to ${urlVal} due to network error: ${err.message}. Retries left: ${retries}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return fetchWithRetry(urlOrRequest, initOptions, retries - 1, delay * 2);
                }
                throw err;
            }
        };

        window.fetch = async function(...args) {
            let urlVal = '';
            if (args[0]) {
                if (typeof args[0] === 'string') {
                    urlVal = args[0];
                } else if (typeof args[0] === 'object') {
                    urlVal = args[0].url || args[0].href || String(args[0]);
                }
            }
            const options = args[1] || {};
            const bypass = options.bypassInterceptor || (options.headers && (options.headers['X-Bypass-Interceptor'] || (options.headers.get && options.headers.get('X-Bypass-Interceptor'))));
            const { isApi, isSessionOrDebug } = checkUrl(urlVal);

            try {
                const response = await fetchWithRetry(args[0], args[1]);
                if (!response.ok && !bypass) {
                    if (isApi) {
                        // Never show full-screen error overlays for background API requests.
                        // Only show toast notifications, except for expected auth/session checks or debug requests.
                        if (!isSessionOrDebug && response.status >= 400) {
                            response.clone().json().then(data => {
                                let msg = data && (data.message || data.error);
                                if (!msg) {
                                    msg = getFriendlyErrorMessage(response.status);
                                }
                                self.showError(msg);
                            }).catch(() => {
                                self.showError(getFriendlyErrorMessage(response.status));
                            });
                        }
                    } else {
                        // Page resource requests (e.g. scripts, stylesheets, pages)
                        if (response.status >= 500 || response.status === 401 || response.status === 403 || response.status === 404) {
                            self.showHttpError(response.status);
                        } else if (response.status >= 400) {
                            self.showError(getFriendlyErrorMessage(response.status));
                        }
                    }
                }
                return response;
            } catch (error) {
                // Background APIs should handle their own connection errors; only display connection warnings for page-level assets
                if (!bypass && !isApi) {
                    self.showError(getFriendlyErrorMessage(0));
                }
                throw error;
            }
        };

        // 2. Intercept jQuery AJAX
        if (typeof window.jQuery !== 'undefined') {
            window.jQuery(document).ajaxError(function(event, jqxhr, settings, thrownError) {
                const bypass = settings.bypassInterceptor || (settings.headers && settings.headers['X-Bypass-Interceptor']);
                if (bypass) return;

                const { isApi, isSessionOrDebug } = checkUrl(settings.url);
                if (isApi) {
                    if (!isSessionOrDebug && jqxhr.status >= 400) {
                        let msg = "";
                        try {
                            const data = JSON.parse(jqxhr.responseText);
                            msg = data && (data.message || data.error);
                        } catch (e) {}
                        if (!msg) {
                            msg = getFriendlyErrorMessage(jqxhr.status);
                        }
                        self.showError(msg);
                    }
                } else {
                    if (jqxhr.status >= 500 || jqxhr.status === 401 || jqxhr.status === 403 || jqxhr.status === 404) {
                        self.showHttpError(jqxhr.status);
                    } else if (jqxhr.status >= 400) {
                        let msg = "";
                        try {
                            const data = JSON.parse(jqxhr.responseText);
                            msg = data && (data.message || data.error);
                        } catch (e) {}
                        if (!msg) {
                            msg = getFriendlyErrorMessage(jqxhr.status);
                        }
                        self.showError(msg);
                    } else if (jqxhr.status === 0 && jqxhr.statusText !== 'abort') {
                        self.showError("Network Error", "Could not connect to the server. Please check your internet connection.");
                    }
                }
            });
        }

        // 3. Global JS Errors
        window.addEventListener('error', function(e) {
            // Ignore cross-origin script errors or harmless things
            if (e.message && e.message.toLowerCase().includes('script error')) return;
            console.error('[Global Error]', e.error || e.message);
            self.showError('An unexpected client error occurred. Our team has been notified.');
        });

        window.addEventListener('unhandledrejection', function(e) {
            console.error('[Unhandled Promise Rejection]', e.reason);
            // Don't show toast for AbortError or it will spam the user on cancelled fetches
            if (e.reason && e.reason.name === 'AbortError') return;
            // Optionally notify user for other promise rejections
            // self.showError('An unexpected process failed.');
        });
    }
}

// ─── Global singleton ─────────────────────────────────────────────────────────
window.notificationService = new NotificationService();
window.notificationService.setupGlobalInterceptors();

// Override native alert() — confirm/prompt require async refactoring at call site
window.alert = function(msg) {
    var str = String(msg == null ? '' : msg);
    // Suppress blank or purely-numeric calls (debug artifacts like alert(1)).
    // Log a trace so the call site can be identified in DevTools if needed.
    if (!str || /^\s*\d+\s*$/.test(str)) {
        console.warn('[window.alert] Suppressed non-message alert. Value:', msg);
        console.trace();
        return;
    }
    window.notificationService.showAlert({ title: 'Notice', message: str });
};
