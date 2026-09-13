/* ============================================================================
   Webengage Studio — app shell behaviour

   Builds the profile menu, which is the whole of the app's navigation: the
   signed-in user, then every destination (All Tools, each tool with its own
   sections, the admin area), then Log out. The nav bar itself stays subtle —
   logo and profile only. Also the single place where session handling lives.

   A page opts in, before this script:

       <script>
         window.STUDIO_SHELL = {
           active: 'studio',        // which tool is current
           section: 'studio',       // which of its sections is showing
           onSection: (key) => {},  // called instead of navigating, for sections
                                    // that are views inside the current page
         };
       </script>
   ========================================================================== */

(function () {
    const config = Object.assign(
        { active: null, section: null, onSection: null },
        window.STUDIO_SHELL || {}
    );

    /* Line icons, drawn in currentColor. Sizing comes from `.icon` in
       theme.css so every icon stays consistent. */
    const ICONS = {
        grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
        image: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M3.5 17l4.8-4.2a2 2 0 0 1 2.6 0L20 19"/>',
        layers: '<path d="M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5z"/><path d="M3.5 12.5 12 17l8.5-4.5"/><path d="M3.5 16.5 12 21l8.5-4.5"/>',
        library: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M9 4h5.5A1.5 1.5 0 0 1 16 5.5v13A1.5 1.5 0 0 1 14.5 20H9z"/><path d="M17.5 5.2l2 .5a1.5 1.5 0 0 1 1 1.8l-2.6 11.2"/>',
        users: '<path d="M15.5 20v-1.8a3.7 3.7 0 0 0-3.7-3.7H6.7A3.7 3.7 0 0 0 3 18.2V20"/><circle cx="9.2" cy="7.8" r="3.4"/><path d="M21 20v-1.8a3.7 3.7 0 0 0-2.8-3.6"/><path d="M15.4 4.6a3.4 3.4 0 0 1 0 6.4"/>',
        chevronDown: '<path d="M5.5 9 12 15.5 18.5 9"/>',
        chevronRight: '<path d="M9 5.5 15.5 12 9 18.5"/>',
        arrowRight: '<path d="M5 12h14"/><path d="M12.5 5.5 19 12l-6.5 6.5"/>',
        plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
        refresh: '<path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4.5v4h4"/><path d="M4 12.5A8 8 0 0 0 17.7 17.7L20 15.5"/><path d="M20 19.5v-4h-4"/>',
        logOut: '<path d="M15 4.5h2.5A2 2 0 0 1 19.5 6.5v11a2 2 0 0 1-2 2H15"/><path d="M10.5 8 6.5 12l4 4"/><path d="M6.5 12H15"/>',
        menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
        link: '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2.8-2.8a3.5 3.5 0 0 0-5-5L12 7"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0L5.7 13.3a3.5 3.5 0 0 0 5 5L12 17"/>',
        clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
        shieldOff: '<path d="M12 3.2l7 2.6v5.4c0 4.2-2.8 7.4-7 9.6-4.2-2.2-7-5.4-7-9.6V5.8z"/><path d="M9 12.2l2 2 4-4.2"/>',
    };

    // Exposed so pages can use the same icons in their own markup
    window.shellIcon = function shellIcon(name, extraClass) {
        const body = ICONS[name] || '';
        return `<svg class="icon${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
    };

    /* The navigation tree, rendered inside the profile menu. A tool with
       `children` lists its sections nested underneath it, so the relationship
       between a tool and its sections stays visible. */
    const NAV = [
        { type: 'label', label: 'Studio' },
        { key: 'tools', label: 'All Tools', icon: 'grid', href: 'tools.html' },
        {
            key: 'studio',
            label: 'Dynamic Images',
            icon: 'image',
            href: 'index.html',
            children: [
                { key: 'studio', label: 'Studio Workspace', icon: 'layers', href: 'index.html?view=studio' },
                { key: 'templates', label: 'Templates Library', icon: 'library', href: 'index.html?view=templates' },
            ],
        },
        {
            key: 'timers',
            label: 'Countdown Timers',
            icon: 'clock',
            href: 'timers.html',
            children: [
                { key: 'builder', label: 'Timer Builder', icon: 'layers', href: 'timers.html?view=builder' },
                { key: 'library', label: 'Timer Library', icon: 'library', href: 'timers.html?view=library' },
            ],
        },
        { type: 'label', label: 'Administration', adminOnly: true },
        { key: 'admin', label: 'Members', icon: 'users', href: 'admin.html', adminOnly: true },
    ];

    function initials(name) {
        return String(name || '?')
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part.charAt(0))
            .join('');
    }

    /* ------------------------------------------------------ session handling */

    /* Every API call in the app goes through here. `apiUrl` points it at the
       right host (the page's own, or the deployed app when these files are
       being served as a static site), and `credentials: 'include'` is what
       carries the session cookie when those differ. */
    window.apiFetch = async function apiFetch(url, options) {
        const response = await fetch(
            window.apiUrl(url),
            Object.assign({ credentials: 'include' }, options || {})
        );

        if (response.status === 401) {
            window.location.replace(`login.html?next=${encodeURIComponent(window.location.pathname)}`);
            throw new Error('Session expired');
        }
        if (response.status === 403) {
            window.location.replace('tools.html');
            throw new Error('Access removed');
        }

        return response;
    };

    async function logout() {
        try {
            await fetch(window.apiUrl('/api/v1/auth/logout'), { method: 'POST', credentials: 'include' });
        } finally {
            window.location.replace('login.html');
        }
    }

    // Signing out here only clears this browser's cookie. This withdraws every
    // token the account has outstanding, which is what you want after using a
    // shared machine or if a session may have leaked.
    async function logoutEverywhere() {
        const confirmed = window.confirm(
            'Sign out of every browser and device this account is signed in on?'
        );
        if (!confirmed) return;

        try {
            await fetch(window.apiUrl('/api/v1/auth/logout-all'), { method: 'POST', credentials: 'include' });
        } finally {
            window.location.replace('login.html');
        }
    }

    /* --------------------------------------------------------------- menus */

    function closeAllMenus(except) {
        document.querySelectorAll('.nav-node.open').forEach((node) => {
            if (node !== except) node.classList.remove('open');
        });
    }

    function wireMenu(node, trigger) {
        trigger.addEventListener('click', (event) => {
            event.preventDefault();
            const willOpen = !node.classList.contains('open');
            closeAllMenus(node);
            node.classList.toggle('open', willOpen);
            trigger.setAttribute('aria-expanded', String(willOpen));
        });
    }

    /* ----------------------------------------------------------- rendering */

    // One destination in the profile menu. Children are nested under it.
    function buildMenuEntry(item) {
        const fragment = document.createDocumentFragment();
        const isCurrent = item.key === config.active;

        const link = document.createElement('a');
        link.href = item.href;
        link.className = `nav-menu-item${isCurrent && !item.children ? ' active' : ''}`;
        link.innerHTML = `${window.shellIcon(item.icon)}<span>${item.label}</span>`;
        if (isCurrent && item.children) link.classList.add('active');
        fragment.appendChild(link);

        if (!item.children) return fragment;

        const sub = document.createElement('div');
        sub.className = 'nav-menu-sub';

        item.children.forEach((child) => {
            const childLink = document.createElement('a');
            childLink.href = child.href;
            childLink.className = 'nav-menu-item';
            childLink.dataset.section = child.key;
            if (isCurrent && child.key === config.section) childLink.classList.add('active');
            childLink.innerHTML = `${window.shellIcon(child.icon)}<span>${child.label}</span>`;

            // A section that is a view inside this very page switches in place
            if (isCurrent && typeof config.onSection === 'function') {
                childLink.addEventListener('click', (event) => {
                    event.preventDefault();
                    closeAllMenus();
                    config.onSection(child.key);
                });
            }

            sub.appendChild(childLink);
        });

        fragment.appendChild(sub);
        return fragment;
    }

    function renderProfileMenu() {
        const slot = document.getElementById('shellUser');
        if (!slot) return;

        slot.className = 'nav-node';
        slot.innerHTML = `
            <button class="nav-user" id="shellUserBtn" type="button" aria-expanded="false"
                aria-label="Account and navigation">
              <span class="shell-avatar" id="shellAvatar">–</span>
              <span class="nav-user-name" id="shellUserName">Loading…</span>
              ${window.shellIcon('chevronDown', 'nav-caret')}
            </button>
            <div class="nav-menu" id="shellMenu">
              <div class="nav-menu-user">
                <div class="name" id="shellMenuName">Loading…</div>
                <div class="email" id="shellMenuEmail"></div>
                <span class="shell-role" id="shellMenuRole"></span>
              </div>
              <div id="shellNav"></div>
              <div class="nav-menu-divider"></div>
              <button class="nav-menu-item" id="shellLogout" type="button">
                ${window.shellIcon('logOut')}<span>Log out</span>
              </button>
              <button class="nav-menu-item" id="shellLogoutAll" type="button">
                ${window.shellIcon('shieldOff')}<span>Log out everywhere</span>
              </button>
            </div>`;

        const nav = slot.querySelector('#shellNav');

        NAV.forEach((item) => {
            let node;

            if (item.type === 'label') {
                node = document.createElement('div');
                node.className = 'nav-menu-label';
                node.textContent = item.label;
            } else {
                // A fragment cannot be hidden, so admin-only entries get a wrapper
                node = document.createElement('div');
                node.appendChild(buildMenuEntry(item));
            }

            // Revealed once /me confirms the role
            if (item.adminOnly) {
                node.style.display = 'none';
                node.dataset.adminOnly = 'true';
            }

            nav.appendChild(node);
        });

        wireMenu(slot, slot.querySelector('#shellUserBtn'));
        slot.querySelector('#shellLogout').addEventListener('click', logout);
        slot.querySelector('#shellLogoutAll').addEventListener('click', logoutEverywhere);
    }

    function paintUser(user) {
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        set('shellAvatar', initials(user.name));
        set('shellUserName', user.name);
        set('shellMenuName', user.name);
        set('shellMenuEmail', user.email);

        const role = document.getElementById('shellMenuRole');
        if (role) {
            role.textContent = user.role;
            role.className = `shell-role visible${user.role === 'admin' ? '' : ' member'}`;
        }

        if (user.role === 'admin') {
            document.querySelectorAll('[data-admin-only="true"]').forEach((el) => {
                el.style.display = '';
            });
        }
    }

    async function loadUser() {
        try {
            const response = await window.apiFetch('/api/v1/auth/me');
            const { user } = await response.json();
            window.shellUser = user;
            paintUser(user);
            document.dispatchEvent(new CustomEvent('shell:user', { detail: user }));
        } catch (err) {
            /* apiFetch already redirected */
        }
    }

    /* ------------------------------------------------------- public hooks */

    window.Shell = {
        // Lets a page move the menu highlight when it switches section in place
        setSection(key) {
            config.section = key;
            document.querySelectorAll('.nav-menu-item[data-section]').forEach((item) => {
                item.classList.toggle('active', item.dataset.section === key);
            });
        },
        logout,
        logoutEverywhere,
    };

    function start() {
        renderProfileMenu();

        document.addEventListener('click', (event) => {
            if (!event.target.closest('.nav-node')) closeAllMenus();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeAllMenus();
        });

        loadUser();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
