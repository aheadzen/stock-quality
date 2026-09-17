    const root = document.getElementById('root');
    const AUTH_KEY = 'stockQuality.reportAuth';
    const PASS_KEY = 'stockQuality.reportPasscode';

    function setStatus(text, kind = '') {
      const el = document.getElementById('status');
      if (!el) return;
      el.textContent = text;
      el.className = 'status' + (kind ? ' ' + kind : '');
    }

    function escapeHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function pctClass(score, total) {
      if (!total) return 'gray';
      const pct = (score / total) * 100;
      if (pct >= 70) return 'good';
      if (pct >= 40) return 'mid';
      return 'bad';
    }

    function pickTimestamp(r) {
      if (r.status === 'done' && r.evaluated_at) {
        return { ts: r.evaluated_at, verb: 'evaluated' };
      }
      if (r.status === 'pending' || r.status === 'processing') {
        return { ts: r.created_at, verb: 'queued' };
      }
      return { ts: r.updated_at || r.created_at, verb: 'updated' };
    }

    function formatRelative(ms) {
      if (!ms || ms < 0) return '';
      const diff = Math.max(0, Date.now() - ms);
      const sec = Math.floor(diff / 1000);
      if (sec < 5) return 'just now';
      if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'} ago`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
      const day = Math.floor(hr / 24);
      if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
      const mo = Math.floor(day / 30);
      if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
      const yr = Math.floor(day / 365);
      return `${yr} year${yr === 1 ? '' : 's'} ago`;
    }

    // --- router ---

    function getRoute() {
      const p = location.pathname || '/';
      const parts = p.split('/').filter(Boolean);
      if (parts.length === 0) return { name: 'dashboard' };
      if (parts[0] === 'stock' && parts[1]) return { name: 'detail', ticker: decodeURIComponent(parts[1]).toUpperCase() };
      if (parts[0] === 'lists' && parts.length === 1) return { name: 'lists' };
      if (parts[0] === 'lists' && parts[1]) return { name: 'listDetail', id: Number(parts[1]) };
      if (parts[0] === 'admin') return { name: 'admin' };
      return { name: 'notFound' };
    }

    // History API navigation. pushState + dispatch gives the same UX as the
    // old hashchange — the URL changes without a full page reload, and the
    // router picks up the new path. Back/forward buttons are wired through
    // the popstate listener below.
    function navigate(path) {
      if (!path.startsWith('/')) path = '/' + path;
      history.pushState({}, '', path);
      dispatch();
    }

    // Per-route <head>. Called by each render*() so client-side navigation
    // (after the initial server-rendered head) still updates the tab title +
    // OG/Twitter/canonical meta + robots. Idempotent — safe to call twice
    // for the same route (e.g., after a server-side renderDetail fetch).
    function setRouteHead({ title, description, noindex = false, ogImage, ogImageAlt }) {
      const baseUrl = 'https://app.ifintok.com';
      const url = baseUrl + (location.pathname || '/');

      if (typeof title === 'string') document.title = title;
      if (typeof description === 'string') setMeta('name', 'description', description);
      if (typeof title === 'string') {
        setMeta('property', 'og:title', title);
        setMeta('name', 'twitter:title', title);
      }
      if (typeof description === 'string') {
        setMeta('property', 'og:description', description);
        setMeta('name', 'twitter:description', description);
      }
      setMeta('property', 'og:url', url);
      setCanonical(url);
      setMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow');

      // og:image / twitter:image. Caller passes an absolute URL; the server
      // serves the right PNG (per-ticker or generic default) regardless.
      if (typeof ogImage === 'string') {
        setMeta('property', 'og:image', ogImage);
        setMeta('name', 'twitter:image', ogImage);
      }
      if (typeof ogImageAlt === 'string') {
        setMeta('property', 'og:image:alt', ogImageAlt);
        setMeta('name', 'twitter:image:alt', ogImageAlt);
      }
    }

    function setMeta(attr, key, value) {
      let el = document.querySelector('meta[' + attr + '="' + key + '"]');
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute('content', value);
    }

    function setCanonical(url) {
      let el = document.querySelector('link[rel="canonical"]');
      if (!el) {
        el = document.createElement('link');
        el.setAttribute('rel', 'canonical');
        document.head.appendChild(el);
      }
      el.setAttribute('href', url);
    }

    // --- auth state ---
    let currentUser = null;

    async function fetchMe() {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) { currentUser = null; return null; }
        const j = await res.json();
        currentUser = j.user || null;
        return currentUser;
      } catch (err) {
        currentUser = null;
        return null;
      }
    }

    function renderHeader() {
      const right = currentUser
        ? `<div class="dropdown" id="user-dropdown">
             <span class="user-chip" id="user-chip">
               <span>${escapeHtml(currentUser.email)}</span>
               <span class="role-badge ${currentUser.role === 'admin' ? 'admin' : 'user'}">${escapeHtml(currentUser.role)}</span>
             </span>
             <div class="dropdown-menu" id="user-menu" style="display:none;">
               <button data-nav="/lists">My Lists</button>
               ${currentUser.role === 'admin' ? '<button data-nav="/admin">Admin</button>' : ''}
               <button data-action="logout-all">Logout all sessions</button>
               <button data-action="logout">Logout</button>
             </div>
           </div>`
        : `<button class="nav-link signin" id="signin-btn">Sign in</button>`;
      return `
        <div class="header-bar">
          <div class="header-links">
            <button class="nav-link" data-nav="/">Dashboard</button>
            ${currentUser ? '<button class="nav-link" data-nav="/lists">My Lists</button>' : ''}
            ${currentUser && currentUser.role === 'admin' ? '<button class="nav-link" data-nav="/admin">Admin</button>' : ''}
          </div>
          <div class="header-links">${right}</div>
        </div>
      `;
    }

    function wireHeader() {
      const signin = document.getElementById('signin-btn');
      if (signin) signin.addEventListener('click', () => openAuthModal('login'));
      const chip = document.getElementById('user-chip');
      const menu = document.getElementById('user-menu');
      if (chip && menu) {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        });
        document.addEventListener('click', () => { menu.style.display = 'none'; }, { once: true });
        menu.addEventListener('click', async (e) => {
          const btn = e.target.closest('button');
          if (!btn) return;
          const nav = btn.getAttribute('data-nav');
          const action = btn.getAttribute('data-action');
          menu.style.display = 'none';
          if (nav) navigate(nav);
          if (action === 'logout') {
            await fetch('/api/auth/logout', { method: 'POST' });
            currentUser = null;
            navigate('/');
          }
          if (action === 'logout-all') {
            await fetch('/api/auth/logout-all', { method: 'POST' });
            currentUser = null;
            navigate('/');
          }
        });
      }
      document.querySelectorAll('button[data-nav]').forEach((b) => {
        if (b.closest('.header-bar')) {
          b.addEventListener('click', (e) => {
            const nav = b.getAttribute('data-nav');
            if (nav) navigate(nav);
          });
        }
      });
    }

    function openAuthModal(mode) {
      const root = document.getElementById('root');
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.id = 'auth-modal';
      wrap.innerHTML = `
        <div class="modal" id="auth-modal-card">
          <h2 id="auth-modal-title">${mode === 'login' ? 'Sign in' : 'Create account'}</h2>
          <p>${mode === 'login' ? 'Sign in to evaluate multiple stocks and group them into lists.' : 'Register to evaluate multiple stocks and group them into lists.'}</p>
          <form id="auth-form">
            <div class="form-field">
              <label for="auth-email">Email</label>
              <input type="email" id="auth-email" autocomplete="email" required />
            </div>
            <div class="form-field">
              <label for="auth-password">Password (min 8 chars)</label>
              <input type="password" id="auth-password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required />
            </div>
            <div class="modal-error" id="auth-error"></div>
            <div class="actions">
              <button type="button" class="secondary" id="auth-cancel">Cancel</button>
              <button type="submit" id="auth-submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
            </div>
          </form>
          <div class="toggle">
            ${mode === 'login'
              ? 'No account? <button type="button" id="auth-toggle">Create one</button>'
              : 'Have an account? <button type="button" id="auth-toggle">Sign in</button>'}
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
      const close = () => wrap.remove();
      const setErr = (m) => { document.getElementById('auth-error').textContent = m || ''; };
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) close();
      });
      document.getElementById('auth-cancel').addEventListener('click', close);
      document.getElementById('auth-toggle').addEventListener('click', () => {
        close();
        openAuthModal(mode === 'login' ? 'register' : 'login');
      });
      document.getElementById('auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;
        const submit = document.getElementById('auth-submit');
        submit.disabled = true;
        setErr('');
        try {
          const res = await fetch(`/api/auth/${mode}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            setErr(j.error || `HTTP ${res.status}`);
            submit.disabled = false;
            return;
          }
          close();
          await fetchMe();
          // Re-render current route.
          dispatch();
        } catch (err) {
          setErr(`Network error: ${err.message}`);
          submit.disabled = false;
        }
      });
    }

    function renderDashboard() {
      setRouteHead({
        title: 'Investment Quality — Stock & Crypto Evaluation Dashboard',
        description: 'Evaluate any stock, crypto, IPO or idea against a 25-point business quality checklist. Public scores, no signup required to browse.',
        ogImage: 'https://app.ifintok.com/og/default.png',
        ogImageAlt: 'Investment Quality — Stock & Crypto Evaluation Dashboard',
      });
      const isAuthed = !!currentUser;
      const formSection = isAuthed
        ? `
          <div class="multi-form">
            <textarea id="multi-input" placeholder="Enter tickers, names, or ideas — comma-separated or one per line (e.g. AAPL, MSFT, Berkshire Hathaway)"></textarea>
            <div class="file-row">
              <label>CSV file: <input type="file" id="csv-file" accept=".csv,text/csv" /></label>
              <span class="file-meta" id="csv-meta"></span>
            </div>
            <div class="row-controls">
              <input type="text" id="new-list-name" placeholder="Optional: save as list named…" />
              <button type="button" id="evaluate-multi">Evaluate</button>
            </div>
          </div>
        `
        : `
          <div class="auth-banner">
            <strong>Sign in</strong> to evaluate multiple stocks at once, group them into private lists, and export results as CSV.
            <button class="nav-link signin" style="margin-left: 8px; padding: 2px 10px;" id="banner-signin">Sign in</button>
          </div>
          <form class="form" id="form" autocomplete="off">
            <div class="combobox" id="combobox">
              <input type="text" id="input" placeholder="Enter ticker or company name (e.g. RELIANCE, Tata Motors, AAPL)" autocomplete="off" required />
              <ul class="combobox-list" id="combobox-list" role="listbox" hidden></ul>
            </div>
            <button type="submit" id="btn">Evaluate</button>
          </form>
        `;
      root.innerHTML = `
        ${renderHeader()}
        <h1>Investment Quality</h1>
        <p class="tagline">Prepare for the worst, hope for the best.</p>
        <p class="subtitle">Evaluate any stock, crypto, IPO or idea against a business quality checklist.</p>
        ${formSection}
        <div class="status" id="status"></div>
        <div class="dashboard">
          <div class="column">
            <h2>Recent</h2>
            <div id="requests-list"></div>
          </div>
          <div class="column">
            <h2>Best</h2>
            <div id="best-list"></div>
          </div>
        </div>
      `;
      wireHeader();
      if (isAuthed) wireMultiDashboard();
      else wireDashboard();
      refreshAll();
    }

    async function renderDetail(ticker) {
      // Optimistic title while we wait for /api/best to resolve the name.
      setRouteHead({
        title: `${ticker} — Investment Quality`,
        description: `${ticker} quality evaluation report.`,
        ogImage: `https://app.ifintok.com/og/${encodeURIComponent(ticker)}.png`,
        ogImageAlt: `${ticker} — Investment Quality`,
      });
      root.innerHTML = `
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px;">
          <button class="secondary" id="back-btn">← Back</button>
          <a class="secondary" id="download-img-btn"
             href="/og/${encodeURIComponent(ticker)}.png"
             download="${escapeHtml(ticker)}-investment-quality.png"
             style="text-decoration: none; display: inline-block; margin-left: auto;">⬇ Download image</a>
          <button class="danger" id="delete-btn">Delete</button>
        </div>
        <div id="detail-body">
          <div class="empty">Loading ${escapeHtml(ticker)}…</div>
        </div>
      `;
      document.getElementById('back-btn').addEventListener('click', () => navigate('/'));
      document.getElementById('delete-btn').addEventListener('click', () => showDeletePrompt(ticker));
      await renderDetailBody(ticker);
    }

    function showDeletePrompt(ticker) {
      const body = document.getElementById('detail-body');
      body.innerHTML = `
        <div class="passcode-prompt">
          <h3 style="color: var(--red);">Delete ${escapeHtml(ticker)}?</h3>
          <p>This permanently removes the cached evaluation, factors, company record, and request history for this ticker. Enter the 4-digit passcode to confirm.</p>
          <form class="passcode-form" id="delete-form">
            <input type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" id="delete-input" />
            <button type="submit" class="danger">Delete</button>
          </form>
          <div class="passcode-error" id="delete-error"></div>
          <button class="secondary" id="delete-cancel" style="margin-top: 12px;">Cancel</button>
        </div>
      `;
      const input = document.getElementById('delete-input');
      document.getElementById('delete-cancel').addEventListener('click', () => renderDetailBody(ticker));
      document.getElementById('delete-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const typed = input.value.trim();
        if (!typed) {
          document.getElementById('delete-error').textContent = 'Please enter a 4-digit code.';
          return;
        }
        const errEl = document.getElementById('delete-error');
        errEl.textContent = 'Deleting…';
        try {
          const res = await fetch('/api/report/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker, passcode: typed }),
          });
          if (res.status === 403) {
            errEl.textContent = 'Wrong passcode.';
            input.value = '';
            input.focus();
            return;
          }
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            errEl.textContent = j.error || `HTTP ${res.status}`;
            return;
          }
          // Clear in-tab passcode cache and bounce back to dashboard.
          sessionStorage.removeItem(PASS_KEY);
          navigate('/');
        } catch (err) {
          errEl.textContent = `Network error: ${err.message}`;
        }
      });
    }

    function renderFactorRow(f) {
      const scoreCell = f.error
        ? '<span class="score err">ERR</span>'
        : f.score === 1
          ? '<span class="score good">1</span>'
          : '<span class="score bad">0</span>';
      const reasoningClass = f.error ? 'reasoning error' : 'reasoning';
      const reasoningText = f.error ? f.error : f.reasoning;
      return `
        <div class="factors-row">
          <div class="idx">#${f.idx + 1}</div>
          <div>
            <div class="question">${escapeHtml(f.question)}</div>
            <div class="${reasoningClass}">${escapeHtml(reasoningText)}</div>
          </div>
          <div>${scoreCell}</div>
        </div>
      `;
    }

    async function renderDetailBody(ticker, errorMsg = '') {
      const body = document.getElementById('detail-body');
      body.innerHTML = '<div class="empty">Loading…</div>';

      // Pull company metadata from /api/best or /api/requests?status=ongoing.
      let header = null;
      try {
        const [ongoing, best] = await Promise.all([
          fetch('/api/requests?status=ongoing').then((r) => r.json()),
          fetch('/api/best').then((r) => r.json()),
        ]);
        header =
          (best.requests || []).find((r) => r.ticker === ticker) ||
          (ongoing.requests || []).find((r) => r.ticker === ticker) ||
          null;
      } catch (e) { /* ignore */ }

      if (!header) {
        body.innerHTML = `
          <div class="empty">
            No recent activity for <strong>${escapeHtml(ticker)}</strong>.
            Submit it from the dashboard first.
          </div>
        `;
        return;
      }

      const kind = header.kind || 'listed';
      const detailCountry = (kind !== 'crypto' && header.country)
        ? `<span class="card-country" title="Country of incorporation/headquarters">${escapeHtml(header.country)}</span>`
        : '';
      // Now that we have the company + score, refresh the head. Mirrors the
      // server-rendered head so client-side navigation matches a hard refresh.
      const displayName = header.name || ticker;
      const detailDescription = (typeof header.score === 'number' && typeof header.total === 'number')
        ? `${displayName} (${ticker}) scored ${header.score}/${header.total} on the Investment Quality checklist. View the full breakdown of business quality factors.`
        : `${displayName} (${ticker}) — Investment Quality evaluation.`;
      setRouteHead({
        title: `${ticker} — ${displayName} Quality Report | Investment Quality`,
        description: detailDescription,
        ogImage: `https://app.ifintok.com/og/${encodeURIComponent(ticker)}.png`,
        ogImageAlt: detailDescription,
      });
      const headerHtml = `
        <div class="detail-header">
          <span class="card-name">${escapeHtml(header.name || ticker)}</span>
          <span class="card-ticker">(${escapeHtml(ticker)})</span>
          <span class="kind-badge kind-badge-${kind}">${escapeHtml(kind.toUpperCase())}</span>
          ${detailCountry}
        </div>
        <div class="detail-meta">${escapeHtml(header.profile || '')}</div>
        <div class="detail-summary">
          <div class="detail-score ${pctClass(header.score, header.total)}">
            ${typeof header.score === 'number' ? `${header.score} / ${header.total || '?'}` : ''}
          </div>
          <div style="color: var(--muted); font-size: 13px;">
            ${header.evaluated_at ? `Evaluated ${escapeHtml(formatRelative(header.evaluated_at))}` : ''}
          </div>
        </div>
      `;

      const storedPasscode = sessionStorage.getItem(PASS_KEY) || '';

      if (!storedPasscode) {
        // No passcode yet — fetch the public preview (first 3 factors).
        // If more factors exist, append a locked section with the passcode
        // form so the user can unlock the full report.
        let preview;
        try {
          const res = await fetch('/api/report/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            body.innerHTML = headerHtml + `<div class="empty">${escapeHtml(j.error || `HTTP ${res.status}`)}</div>`;
            return;
          }
          preview = await res.json();
        } catch (err) {
          body.innerHTML = headerHtml + `<div class="empty">Network error: ${escapeHtml(err.message)}</div>`;
          return;
        }

        // Server returns 404 for empty factors, so by the time we reach here
        // preview.factors is guaranteed non-empty.
        const factorsHtml = preview.factors.map(renderFactorRow).join('');
        const remaining = (preview.total || 0) - preview.factors.length;
        const lockedHtml = remaining > 0
          ? `<div class="factors-locked">
              <h3>${remaining} more question${remaining === 1 ? '' : 's'} behind the passcode</h3>
              <p>Enter the 4-digit code to unlock the full report.</p>
              <form class="passcode-form" id="passcode-form">
                <input type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" id="passcode-input" />
                <button type="submit">Unlock</button>
              </form>
              <div class="passcode-error" id="passcode-error">${escapeHtml(errorMsg)}</div>
            </div>`
          : '';

        body.innerHTML = headerHtml + `<div class="factors-table">${factorsHtml}</div>${lockedHtml}`;

        if (remaining > 0) {
          const form = document.getElementById('passcode-form');
          const input = document.getElementById('passcode-input');
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const typed = input.value.trim();
            if (!typed) {
              document.getElementById('passcode-error').textContent = 'Please enter a 4-digit code.';
              return;
            }
            const errEl = document.getElementById('passcode-error');
            errEl.textContent = 'Checking…';
            try {
              const res = await fetch('/api/report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker, passcode: typed }),
              });
              if (res.status === 403) {
                errEl.textContent = 'Wrong passcode. Try again.';
                input.value = '';
                input.focus();
                return;
              }
              if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                errEl.textContent = j.error || `HTTP ${res.status}`;
                return;
              }
              // Valid: cache it and re-render the full report.
              sessionStorage.setItem(PASS_KEY, typed);
              await renderDetailBody(ticker);
            } catch (err) {
              errEl.textContent = `Network error: ${err.message}`;
            }
          });
        }
        return;
      }

      // Have a stored passcode — fetch the full report.
      let report;
      try {
        const res = await fetch('/api/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker, passcode: storedPasscode }),
        });
        if (res.status === 403) {
          sessionStorage.removeItem(PASS_KEY);
          return renderDetailBody(ticker, 'Wrong passcode. Try again.');
        }
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          body.innerHTML = headerHtml + `<div class="empty">${escapeHtml(j.error || `HTTP ${res.status}`)}</div>`;
          return;
        }
        report = await res.json();
      } catch (err) {
        body.innerHTML = headerHtml + `<div class="empty">Network error: ${escapeHtml(err.message)}</div>`;
        return;
      }

      const factorsHtml = report.factors.map(renderFactorRow).join('');

      body.innerHTML = headerHtml + `<div class="factors-table">${factorsHtml}</div>`;
    }

    // --- dashboard wiring ---

    function renderRequestCard(r, { showStatus = true, clickable = true } = {}) {
      const kind = r.kind || 'listed';
      const ticker = r.ticker ? `<span class="card-ticker">(${escapeHtml(r.ticker)})</span>` : '';
      const badge = `<span class="kind-badge kind-badge-${kind}">${escapeHtml(kind.toUpperCase())}</span>`;
      const country = (kind !== 'crypto' && r.country)
        ? `<span class="card-country" title="Country of incorporation/headquarters">${escapeHtml(r.country)}</span>`
        : '';
      const name = escapeHtml(r.name || r.input || '');
      const profile = escapeHtml(r.profile || '');
      const pill = showStatus
        ? `<span class="status-pill ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>`
        : '';
      const scoreText = (r.status === 'done' && typeof r.score === 'number')
        ? `<span class="score-big ${pctClass(r.score, r.total)}">${r.score} / ${r.total || '?'}</span>`
        : (r.status === 'error'
            ? `<span class="score-big gray" title="${escapeHtml(r.error_message || '')}">ERR</span>`
            : (r.status === 'processing' && typeof r.score === 'number'
                ? `<span class="score-big gray"><span class="score-num">${r.score}</span><span class="score-total"> / ${r.total ?? '?'}</span><div class="score-evaluating">evaluating…</div></span>`
                : ''));
      const ts = pickTimestamp(r);
      const timeText = ts.ts ? `<div class="card-time">${escapeHtml(ts.verb)} ${escapeHtml(formatRelative(ts.ts))}</div>` : '';
      const cursorStyle = clickable ? '' : 'cursor: default;';
      const onClick = clickable && r.ticker
        ? ` onclick="navigate('/stock/${encodeURIComponent(r.ticker)}')"`
        : '';
      return `
        <div class="card kind-${kind}" style="${cursorStyle}"${onClick}>
          <div class="card-body">
            <div class="card-row1">
              <span class="card-name">${name}</span>
              ${ticker}
              ${badge}
              ${country}
              ${pill}
            </div>
            ${profile ? `<div class="card-profile">${profile}</div>` : ''}
            ${timeText}
          </div>
          <div class="card-score">${scoreText}</div>
        </div>
      `;
    }

    function renderOngoing(requests) {
      const el = document.getElementById('requests-list');
      if (!el) return;
      if (!requests || requests.length === 0) {
        el.innerHTML = '<div class="empty">No ongoing requests.</div>';
        return;
      }
      el.innerHTML = requests.map((r) => renderRequestCard(r, { clickable: !!r.ticker })).join('');
    }

    function renderErrors(errors) {
      const el = document.getElementById('requests-list');
      if (!el) return;
      if (!errors || errors.length === 0) return;
      const html = errors.map((e) => {
        const actions = `<div class="error-actions">
          <button class="secondary" data-retry-id="${e.id}">Retry</button>
          <button class="secondary" data-dismiss-id="${e.id}">Delete</button>
        </div>`;
        const msg = e.error_message ? `<div class="error-message">${escapeHtml(e.error_message)}</div>` : '';
        return `<div class="error-card">${renderRequestCard(e, { clickable: false })}${msg}${actions}</div>`;
      }).join('');
      const existing = el.innerHTML;
      el.innerHTML = html + (existing.includes('class="empty"') ? '' : existing);
      // Wire retry buttons.
      el.querySelectorAll('button[data-retry-id]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const id = btn.getAttribute('data-retry-id');
          btn.disabled = true;
          btn.textContent = 'Retrying…';
          try {
            const res = await fetch(`/api/requests/${id}/retry`, { method: 'POST' });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              btn.textContent = j.error || 'Failed';
              btn.disabled = false;
              return;
            }
            await refreshAll();
          } catch (err) {
            btn.textContent = `Network error`;
            btn.disabled = false;
          }
        });
      });
      // Wire dismiss buttons — removes just this one row (no passcode).
      el.querySelectorAll('button[data-dismiss-id]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const id = btn.getAttribute('data-dismiss-id');
          btn.disabled = true;
          btn.textContent = 'Removing…';
          try {
            const res = await fetch(`/api/requests/${id}/dismiss`, { method: 'POST' });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              btn.textContent = j.error || 'Failed';
              btn.disabled = false;
              return;
            }
            await refreshAll();
          } catch (err) {
            btn.textContent = 'Network error';
            btn.disabled = false;
          }
        });
      });
    }

    function renderBest(requests) {
      const el = document.getElementById('best-list');
      if (!el) return;
      if (!requests || requests.length === 0) {
        el.innerHTML = '<div class="empty">No completed evaluations yet.</div>';
        return;
      }
      el.innerHTML = requests.map((r) => renderRequestCard(r, { showStatus: false })).join('');
    }

    async function fetchOngoing() {
      try {
        const res = await fetch('/api/requests?status=ongoing');
        if (!res.ok) return;
        const j = await res.json();
        renderOngoing(j.requests);
        renderErrors(j.errors || []);
        if (j.paused) setStatus('Paused — rate limit hit. Will resume in the background.', 'paused');
      } catch (err) { /* silent */ }
    }

    async function fetchBest() {
      try {
        const res = await fetch('/api/best');
        if (!res.ok) return;
        const j = await res.json();
        renderBest(j.requests);
      } catch (err) { /* silent */ }
    }

    async function refreshAll() {
      await Promise.all([fetchOngoing(), fetchBest()]);
    }

    function wireDashboard() {
      const banner = document.getElementById('banner-signin');
      if (banner) banner.addEventListener('click', () => openAuthModal('login'));
      const form = document.getElementById('form');
      if (!form) return;
      const input = document.getElementById('input');
      const btn = document.getElementById('btn');
      wireCombobox(input);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        btn.disabled = true;
        setStatus(`Queuing "${value}"...`);
        try {
          const res = await fetch('/api/requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: value }),
          });
          const j = await res.json();
          if (!res.ok) {
            setStatus(j.error || `HTTP ${res.status}`, 'error');
          } else if (j.status === 'done') {
            setStatus(`Cached: ${j.score} / ${j.total} (${j.ticker || 'n/a'}).`);
            input.value = '';
            input.focus();
            await refreshAll();
          } else {
            setStatus(`Queued #${j.id}. Watch the Recent column.`);
            input.value = '';
            input.focus();
            await refreshAll();
          }
        } catch (err) {
          setStatus(`Network error: ${err.message}`, 'error');
        } finally {
          btn.disabled = false;
        }
      });
    }

    // Search-as-you-type autocomplete bound to the home form's ticker input.
    // Pulls from /api/stocks?q=… on input (debounced 150ms). Selecting a result
    // fills the input with the SYMBOL and submits the form — the server uses
    // the SYMBOL to skip both the LLM company lookup and the Tavily enrichment
    // for known NSE tickers. Free text (no match) still works and falls through
    // to the existing LLM path.
    function wireCombobox(input) {
      const combobox = document.getElementById('combobox');
      const list = document.getElementById('combobox-list');
      if (!combobox || !list) return;

      let debounceTimer = null;
      let activeIndex = -1;
      let currentMatches = [];
      let lastQuery = '';

      const closeList = () => {
        list.hidden = true;
        list.innerHTML = '';
        activeIndex = -1;
        currentMatches = [];
      };

      const openList = () => {
        if (currentMatches.length > 0) list.hidden = false;
      };

      const renderMatches = (matches) => {
        list.innerHTML = '';
        activeIndex = -1;
        currentMatches = matches;
        if (matches.length === 0) {
          list.hidden = true;
          return;
        }
        for (const m of matches) {
          const li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.dataset.ticker = m.ticker;
          li.innerHTML =
            `<span class="ticker">${escapeHtml(m.ticker)}</span>` +
            `<span class="name">${escapeHtml(m.name)}</span>`;
          li.addEventListener('mousedown', (ev) => {
            // mousedown (not click) so the input's blur doesn't close the list
            // before our handler runs.
            ev.preventDefault();
            choose(m.ticker);
          });
          list.appendChild(li);
        }
        list.hidden = false;
      };

      const choose = (ticker) => {
        input.value = ticker;
        closeList();
        // Submit the parent form.
        const form = input.closest('form');
        if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
      };

      const setActive = (idx) => {
        const items = list.querySelectorAll('li');
        items.forEach((el, i) => el.classList.toggle('active', i === idx));
        activeIndex = idx;
        if (idx >= 0 && items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
      };

      const fetchSuggestions = async (q) => {
        if (q === lastQuery) return;
        lastQuery = q;
        try {
          const res = await fetch(`/api/stocks?q=${encodeURIComponent(q)}&limit=12`);
          if (!res.ok) { closeList(); return; }
          const j = await res.json();
          // Drop late responses that don't match the current query.
          if (q !== lastQuery) return;
          renderMatches(j.stocks || []);
        } catch {
          closeList();
        }
      };

      input.addEventListener('input', () => {
        const q = input.value.trim();
        if (debounceTimer) clearTimeout(debounceTimer);
        if (q.length === 0) { closeList(); lastQuery = ''; return; }
        debounceTimer = setTimeout(() => fetchSuggestions(q), 150);
      });

      input.addEventListener('focus', () => {
        const q = input.value.trim();
        if (q.length > 0 && currentMatches.length > 0) openList();
      });

      input.addEventListener('blur', () => {
        // Delay so a click on a suggestion still registers.
        setTimeout(closeList, 120);
      });

      input.addEventListener('keydown', (e) => {
        const items = list.querySelectorAll('li');
        if (e.key === 'ArrowDown') {
          if (items.length === 0) return;
          e.preventDefault();
          setActive(Math.min(items.length - 1, activeIndex + 1));
        } else if (e.key === 'ArrowUp') {
          if (items.length === 0) return;
          e.preventDefault();
          setActive(Math.max(0, activeIndex - 1));
        } else if (e.key === 'Enter') {
          if (activeIndex >= 0 && items[activeIndex]) {
            e.preventDefault();
            choose(items[activeIndex].dataset.ticker);
          }
        } else if (e.key === 'Escape') {
          if (!list.hidden) {
            e.preventDefault();
            closeList();
          }
        }
      });

      // Click outside the combobox closes the list.
      document.addEventListener('mousedown', (e) => {
        if (!combobox.contains(e.target)) closeList();
      });
    }

    function parseMultiInput(text) {
      const seen = new Set();
      const out = [];
      for (const raw of text.split(/[\n,]+/)) {
        const v = (raw || '').trim();
        if (!v) continue;
        const key = v.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
      }
      return out;
    }

    function wireMultiDashboard() {
      const textarea = document.getElementById('multi-input');
      const fileInput = document.getElementById('csv-file');
      const fileMeta = document.getElementById('csv-meta');
      const btn = document.getElementById('evaluate-multi');
      const listNameInput = document.getElementById('new-list-name');

      if (fileInput) {
        fileInput.addEventListener('change', () => {
          const f = fileInput.files[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            const text = String(reader.result || '');
            textarea.value = text;
            const rows = parseMultiInput(text);
            fileMeta.textContent = `Loaded ${rows.length} ticker${rows.length === 1 ? '' : 's'}.`;
          };
          reader.readAsText(f);
        });
      }

      if (btn) {
        btn.addEventListener('click', async () => {
          const text = textarea.value;
          const inputs = parseMultiInput(text);
          if (inputs.length === 0) {
            setStatus('Please enter at least one ticker.', 'error');
            return;
          }
          const listName = (listNameInput.value || '').trim();
          btn.disabled = true;
          setStatus(`Submitting ${inputs.length} ticker${inputs.length === 1 ? '' : 's'}...`);
          try {
            const endpoint = listName ? '/api/evaluate/upload' : '/api/requests';
            const body = listName
              ? { csv: inputs.join('\n'), newListName: listName }
              : { inputs };
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify(body),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) {
              setStatus(j.error || `HTTP ${res.status}`, 'error');
              return;
            }
            const results = j.results || [];
            const done = results.filter((r) => r.status === 'done').length;
            const pending = results.filter((r) => r.status === 'pending').length;
            const errors = results.filter((r) => r.status === 'error').length;
            let summary = `${results.length} submitted: ${pending} queued, ${done} cached`;
            if (errors > 0) summary += `, ${errors} failed`;
            if (j.list_id) summary += ` → list #${j.list_id}`;
            setStatus(summary + '.');
            textarea.value = '';
            listNameInput.value = '';
            fileInput.value = '';
            fileMeta.textContent = '';
            await refreshAll();
          } catch (err) {
            setStatus(`Network error: ${err.message}`, 'error');
          } finally {
            btn.disabled = false;
          }
        });
      }
    }

    // --- lists page ---

    async function renderLists() {
      setRouteHead({
        title: 'My Lists — Investment Quality',
        description: 'Manage your private stock watchlists and export them as CSV.',
        noindex: true,
        ogImage: 'https://app.ifintok.com/og/default.png',
        ogImageAlt: 'Investment Quality — Stock & Crypto Evaluation Dashboard',
      });
      root.innerHTML = `
        ${renderHeader()}
        <h1>My Lists</h1>
        <p class="subtitle">Group stocks into private lists and export them as CSV.</p>
        <div class="row-controls">
          <input type="text" id="new-list" placeholder="New list name…" />
          <button type="button" id="create-list-btn">Create list</button>
        </div>
        <div id="lists-body" style="margin-top: 24px;"></div>
      `;
      wireHeader();
      const btn = document.getElementById('create-list-btn');
      const nameInput = document.getElementById('new-list');
      btn.addEventListener('click', async () => {
        const name = (nameInput.value || '').trim();
        if (!name) return;
        btn.disabled = true;
        try {
          const res = await fetch('/api/lists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            alert(j.error || `HTTP ${res.status}`);
            return;
          }
          nameInput.value = '';
          await loadLists();
        } finally {
          btn.disabled = false;
        }
      });
      await loadLists();
    }

    async function loadLists() {
      const el = document.getElementById('lists-body');
      if (!el) return;
      el.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const res = await fetch('/api/lists');
        if (!res.ok) {
          el.innerHTML = `<div class="empty">${escapeHtml(`HTTP ${res.status}`)}</div>`;
          return;
        }
        const j = await res.json();
        const lists = j.lists || [];
        if (lists.length === 0) {
          el.innerHTML = '<div class="empty">No lists yet. Create one above.</div>';
          return;
        }
        el.innerHTML = lists.map((l) => `
          <div class="card" onclick="navigate('/lists/${l.id}')">
            <div class="card-body">
              <div class="card-row1">
                <span class="card-name">${escapeHtml(l.name)}</span>
                <span class="card-ticker">${l.item_count} item${l.item_count === 1 ? '' : 's'}</span>
              </div>
              <div class="card-time">Updated ${escapeHtml(formatRelative(l.updated_at))}</div>
            </div>
          </div>
        `).join('');
      } catch (err) {
        el.innerHTML = `<div class="empty">Network error: ${escapeHtml(err.message)}</div>`;
      }
    }

    async function renderListDetail(id) {
      // Optimistic head while the list fetch resolves. Final values are set
      // below once we know the list name + item count.
      setRouteHead({
        title: `List — Investment Quality`,
        description: 'Private stock watchlist.',
        noindex: true,
        ogImage: 'https://app.ifintok.com/og/default.png',
        ogImageAlt: 'Investment Quality — Stock & Crypto Evaluation Dashboard',
      });
      root.innerHTML = `
        ${renderHeader()}
        <div style="display:flex; gap: 8px; align-items: center; margin-bottom: 12px;">
          <button class="secondary" id="back-btn">← My Lists</button>
        </div>
        <div id="list-body"><div class="empty">Loading…</div></div>
      `;
      wireHeader();
      document.getElementById('back-btn').addEventListener('click', () => navigate('/lists'));
      try {
        const res = await fetch(`/api/lists/${id}`);
        if (res.status === 404) {
          document.getElementById('list-body').innerHTML = '<div class="empty">List not found.</div>';
          return;
        }
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          document.getElementById('list-body').innerHTML = `<div class="empty">${escapeHtml(j.error || `HTTP ${res.status}`)}</div>`;
          return;
        }
        const j = await res.json();
        const list = j.list;
        const items = list.items || [];
        // Now that we know the list name, set the proper head.
        setRouteHead({
          title: `${list.name} — Investment Quality`,
          description: `${list.name}: ${items.length} item${items.length === 1 ? '' : 's'}.`,
          noindex: true,
          ogImage: 'https://app.ifintok.com/og/default.png',
          ogImageAlt: 'Investment Quality — Stock & Crypto Evaluation Dashboard',
        });
        const head = `
          <div class="list-detail-header">
            <input type="text" id="list-name" value="${escapeHtml(list.name)}" style="font-size: 18px; font-weight: 600;" />
            <button class="secondary" id="save-name">Rename</button>
            <button class="danger" id="delete-list">Delete list</button>
            <a href="/api/lists/${list.id}/export" download><button>Export CSV</button></a>
          </div>
        `;
        const addRow = `
          <div class="row-controls" style="margin-bottom: 16px;">
            <input type="text" id="add-ticker" placeholder="Ticker (e.g. AAPL)" />
            <button id="add-item-btn">Add</button>
          </div>
        `;
        const rows = items.map((it) => {
          const country = it.country ? `<span class="card-country">${escapeHtml(it.country)}</span>` : '';
          const kind = it.kind ? `<span class="kind-badge kind-badge-${escapeHtml(it.kind)}">${escapeHtml((it.kind || '').toUpperCase())}</span>` : '';
          const stockHref = `/stock/${encodeURIComponent(it.ticker)}`;
          // Score: render as a clickable link to the detail page if we have one.
          const scoreText = (typeof it.score === 'number')
            ? `<a href="${stockHref}">${it.score}</a>`
            : '<span style="color: var(--muted);">—</span>';
          const totalText = (typeof it.total === 'number') ? String(it.total) : '';
          // If the user's original input doesn't match the resolved ticker,
          // show the original as a small subtitle so they can spot mismatches.
          const subtitle = (it.raw_ticker && it.raw_ticker !== it.ticker)
            ? `<div class="cell-subtitle">from "${escapeHtml(it.raw_ticker)}"</div>`
            : '';
          return `
            <div class="list-table-row">
              <div class="cell-ticker">
                <a href="${stockHref}">${escapeHtml(it.ticker)}</a>
                ${subtitle}
              </div>
              <div>${escapeHtml(it.name || '')}</div>
              <div>${kind} ${country}</div>
              <div class="cell-score">${scoreText}</div>
              <div class="cell-total">${escapeHtml(totalText)}</div>
              <div class="cell-actions">
                <button class="secondary" data-remove="${escapeHtml(it.raw_ticker || it.ticker)}">Remove</button>
              </div>
            </div>
          `;
        }).join('');
        const body = `
          ${head}
          ${addRow}
          ${items.length === 0
            ? '<div class="empty">No items yet.</div>'
            : `<div class="list-table">
                <div class="list-table-row head">
                  <div>Ticker</div>
                  <div>Company</div>
                  <div>Kind</div>
                  <div>Score</div>
                  <div>Total</div>
                  <div></div>
                </div>
                ${rows}
              </div>`}
        `;
        document.getElementById('list-body').innerHTML = body;
        // Wire actions
        document.getElementById('save-name').addEventListener('click', async () => {
          const name = document.getElementById('list-name').value.trim();
          if (!name) return;
          const r = await fetch(`/api/lists/${list.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            alert(j.error || `HTTP ${r.status}`);
          }
        });
        document.getElementById('delete-list').addEventListener('click', async () => {
          if (!confirm(`Delete list "${list.name}"?`)) return;
          const r = await fetch(`/api/lists/${list.id}`, { method: 'DELETE' });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            alert(j.error || `HTTP ${r.status}`);
            return;
          }
          navigate('/lists');
        });
        document.getElementById('add-item-btn').addEventListener('click', async () => {
          const ticker = document.getElementById('add-ticker').value.trim().toUpperCase();
          if (!ticker) return;
          const r = await fetch(`/api/lists/${list.id}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickers: [ticker] }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            alert(j.error || `HTTP ${r.status}`);
            return;
          }
          renderListDetail(list.id);
        });
        document.querySelectorAll('button[data-remove]').forEach((btn) => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ticker = btn.getAttribute('data-remove');
            await fetch(`/api/lists/${list.id}/items/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
            renderListDetail(list.id);
          });
        });
      } catch (err) {
        document.getElementById('list-body').innerHTML = `<div class="empty">Network error: ${escapeHtml(err.message)}</div>`;
      }
    }

    // --- admin page ---

    async function renderAdmin() {
      setRouteHead({
        title: 'Admin — Investment Quality',
        description: 'Administer users, requests, companies, and evaluations.',
        noindex: true,
        ogImage: 'https://app.ifintok.com/og/default.png',
        ogImageAlt: 'Investment Quality — Stock & Crypto Evaluation Dashboard',
      });
      root.innerHTML = `
        ${renderHeader()}
        <h1>Admin</h1>
        <p class="subtitle">User management and destructive operations. All actions are logged.</p>
        <div id="admin-body"><div class="empty">Loading…</div></div>
      `;
      wireHeader();
      try {
        const res = await fetch('/api/admin/users');
        if (res.status === 403) {
          document.getElementById('admin-body').innerHTML = '<div class="empty">Admin access required.</div>';
          return;
        }
        if (!res.ok) {
          document.getElementById('admin-body').innerHTML = `<div class="empty">HTTP ${res.status}</div>`;
          return;
        }
        const j = await res.json();
        const users = j.users || [];
        const rows = users.map((u) => `
          <div class="admin-row">
            <div>${escapeHtml(u.email)}</div>
            <div><span class="role-badge ${u.role === 'admin' ? 'admin' : 'user'}">${escapeHtml(u.role)}</span></div>
            <div>${escapeHtml(formatRelative(u.created_at))}</div>
            <div class="cell-actions">
              <button class="secondary" data-promote="${u.id}" data-target-role="${u.role === 'admin' ? 'user' : 'admin'}">
                ${u.role === 'admin' ? 'Demote' : 'Promote'}
              </button>
              <button class="danger" data-delete-user="${u.id}">Delete</button>
            </div>
          </div>
        `).join('');
        document.getElementById('admin-body').innerHTML = `
          <div class="admin-section">
            <h2>Users</h2>
            <div class="admin-table">
              <div class="admin-row head">
                <div>Email</div>
                <div>Role</div>
                <div>Created</div>
                <div></div>
              </div>
              ${rows}
            </div>
          </div>
        `;
        document.querySelectorAll('button[data-promote]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-promote');
            const role = btn.getAttribute('data-target-role');
            const r = await fetch(`/api/admin/users/${id}/role`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role }),
            });
            if (!r.ok) {
              const j = await r.json().catch(() => ({}));
              alert(j.error || `HTTP ${r.status}`);
              return;
            }
            renderAdmin();
          });
        });
        document.querySelectorAll('button[data-delete-user]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-delete-user');
            if (!confirm('Delete this user and all their lists?')) return;
            const r = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
            if (!r.ok) {
              const j = await r.json().catch(() => ({}));
              alert(j.error || `HTTP ${r.status}`);
              return;
            }
            renderAdmin();
          });
        });
      } catch (err) {
        document.getElementById('admin-body').innerHTML = `<div class="empty">Network error: ${escapeHtml(err.message)}</div>`;
      }
    }

    // --- router dispatch ---

    async function dispatch() {
      // Always re-fetch the current user on route change so login/logout from
      // the dropdown updates the header on the next render.
      await fetchMe();
      const route = getRoute();
      if (route.name === 'detail') return renderDetail(route.ticker);
      if (route.name === 'lists') {
        if (!currentUser) return renderDashboard();
        return renderLists();
      }
      if (route.name === 'listDetail') {
        if (!currentUser) return renderDashboard();
        return renderListDetail(route.id);
      }
      if (route.name === 'admin') {
        if (!currentUser || currentUser.role !== 'admin') {
          setRouteHead({
            title: 'Admin — Investment Quality',
            description: 'Admin access required.',
            noindex: true,
            ogImage: 'https://app.ifintok.com/og/default.png',
            ogImageAlt: 'Investment Quality — Stock & Crypto Evaluation Dashboard',
          });
          root.innerHTML = `${renderHeader()}<h1>Admin</h1><div class="empty">Admin access required.</div>`;
          wireHeader();
          return;
        }
        return renderAdmin();
      }
      if (route.name === 'notFound') return renderNotFound();
      return renderDashboard();
    }

    function renderNotFound() {
      setRouteHead({
        title: 'Page not found — Investment Quality',
        description: "That page doesn't exist. Head back to the dashboard.",
        noindex: true,
        ogImage: 'https://app.ifintok.com/og/default.png',
        ogImageAlt: 'Investment Quality — Stock & Crypto Evaluation Dashboard',
      });
      root.innerHTML = `
        ${renderHeader()}
        <h1>404 — Page not found</h1>
        <p class="subtitle">The page you're looking for doesn't exist or has been moved.</p>
        <div style="margin-top: 16px;">
          <button class="secondary" id="back-home">Back to dashboard</button>
        </div>
      `;
      wireHeader();
      const back = document.getElementById('back-home');
      if (back) back.addEventListener('click', () => navigate('/'));
    }

    // Back/forward buttons (pushState calls dispatch() directly, so this
    // only fires when the user navigates via the browser, not when our code
    // calls navigate()).
    window.addEventListener('popstate', dispatch);
    dispatch();

    // Only poll for the dashboard; detail page is one-shot.
    setInterval(() => {
      if (getRoute().name === 'dashboard') refreshAll();
    }, 3000);
