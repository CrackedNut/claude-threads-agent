/**
 * Agent Dashboard UI — a single self-contained HTML page (no build step,
 * no external assets) served by src/panel/server.ts at `/`.
 *
 * Visual language: warm paper + terracotta (Anthropic-ish), serif display
 * headings, dark sidebar, master-detail lists (no dropdowns), toasts.
 *
 * NOTE: this file is a TS template literal — the inner JS deliberately uses
 * string concatenation (no backticks, no dollar-brace) to stay inert.
 */

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenIntel · agent dashboard</title>
<style>
  :root {
    --paper: #FAF9F5; --card: #FFFFFF; --ink: #1F1E1B; --ink-2: #6E6B63;
    --line: #E8E5DC; --line-2: #DDD9CE;
    --accent: #D97757; --accent-deep: #C45F3C; --accent-soft: #F8EDE7;
    --green: #6F8F5A; --green-soft: #EEF2E8; --amber: #B58A3C; --amber-soft: #F7F0E2;
    --red: #BF4D43; --red-soft: #F8E9E7;
    --side: #21201C; --side-ink: #C9C5BA; --side-active: #34322C;
    --serif: ui-serif, 'New York', Georgia, 'Times New Roman', serif;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 14px/1.5 var(--sans); }

  .app { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }

  /* ---------- sidebar ---------- */
  aside { background: var(--side); color: var(--side-ink); display: flex; flex-direction: column;
    padding: 22px 14px 16px; position: sticky; top: 0; height: 100vh; }
  .brand { display: flex; align-items: baseline; gap: 8px; padding: 0 10px 18px; }
  .brand .mark { font-family: var(--serif); font-size: 19px; color: #F5F3EC; letter-spacing: -0.01em; }
  .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); align-self: center;
    box-shadow: 0 0 0 0 rgba(111,143,90,.5); animation: pulse 2.4s infinite; }
  .brand .dot.down { background: var(--red); animation: none; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(111,143,90,.45);} 70% { box-shadow: 0 0 0 7px rgba(111,143,90,0);} 100% { box-shadow: 0 0 0 0 rgba(111,143,90,0);} }
  nav { display: flex; flex-direction: column; gap: 2px; }
  nav a { display: flex; align-items: center; gap: 10px; color: var(--side-ink); text-decoration: none;
    padding: 9px 12px; border-radius: 8px; font-size: 13.5px; transition: background .15s, color .15s; }
  nav a:hover { background: rgba(255,255,255,.05); color: #F5F3EC; }
  nav a.active { background: var(--side-active); color: #F5F3EC; }
  nav a .ico { width: 18px; text-align: center; opacity: .9; }
  .side-foot { margin-top: auto; padding: 0 4px; }
  .side-meta { font-size: 11.5px; color: #7E7A6F; padding: 0 8px 10px; line-height: 1.7; }
  .restart-btn { width: 100%; background: transparent; color: var(--side-ink); border: 1px solid #3A3833;
    border-radius: 8px; padding: 9px 0; font: 600 13px var(--sans); cursor: pointer; transition: all .15s; }
  .restart-btn:hover { border-color: var(--accent); color: var(--accent); }

  /* ---------- main ---------- */
  .main { padding: 30px 38px 60px; max-width: 1180px; width: 100%; }
  .page-head { margin-bottom: 22px; }
  .page-head h1 { font-family: var(--serif); font-weight: 500; font-size: 27px; margin: 0 0 4px; letter-spacing: -0.015em; }
  .page-head p { margin: 0; color: var(--ink-2); font-size: 13.5px; }
  .page-head code { font-family: var(--mono); font-size: 12px; background: var(--card); border: 1px solid var(--line);
    padding: 1px 7px; border-radius: 6px; }

  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 22px; }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .stat .k { font-size: 11.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-2); margin-bottom: 6px; }
  .stat .v { font-family: var(--serif); font-size: 22px; }
  .stat .v small { font-size: 13px; color: var(--ink-2); font-family: var(--sans); }

  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 99px; font-size: 11.5px; font-weight: 600; }
  .pill.on { background: var(--green-soft); color: var(--green); }
  .pill.off { background: var(--red-soft); color: var(--red); }
  .pill.busy { background: var(--amber-soft); color: var(--amber); }
  .pill.mode { background: var(--accent-soft); color: var(--accent-deep); }

  .list { display: flex; flex-direction: column; }
  .list .item { display: flex; align-items: center; gap: 12px; padding: 13px 4px; border-bottom: 1px solid var(--line); }
  .list .item:last-child { border-bottom: none; }
  .item .grow { flex: 1; min-width: 0; }
  .item .title { font-weight: 600; font-size: 13.5px; }
  .item .sub { color: var(--ink-2); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* ---------- editors ---------- */
  textarea, input[type=text] { width: 100%; background: #FCFBF8; color: var(--ink); border: 1px solid var(--line-2);
    border-radius: 10px; padding: 13px 14px; font: 13px/1.55 var(--mono); transition: border .15s, box-shadow .15s; }
  textarea:focus, input[type=text]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(217,119,87,.13); }
  textarea { min-height: 56vh; resize: vertical; }
  textarea.tall { min-height: 62vh; }
  .editor-bar { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
  .btn { background: var(--accent); color: #fff; border: none; border-radius: 9px; padding: 9px 20px;
    font: 600 13px var(--sans); cursor: pointer; transition: background .15s, transform .05s; }
  .btn:hover { background: var(--accent-deep); }
  .btn:active { transform: translateY(1px); }
  .btn[disabled] { background: var(--line-2); color: var(--ink-2); cursor: default; }
  .btn.subtle { background: transparent; color: var(--ink); border: 1px solid var(--line-2); }
  .btn.subtle:hover { border-color: var(--ink-2); background: transparent; }
  .btn.danger { background: transparent; color: var(--red); border: 1px solid var(--line-2); }
  .btn.danger:hover { border-color: var(--red); }
  .bar-note { color: var(--ink-2); font-size: 12.5px; }

  /* ---------- segmented control ---------- */
  .seg { display: inline-flex; background: #EFEDE5; border-radius: 10px; padding: 3px; margin-bottom: 16px; }
  .seg button { border: none; background: transparent; padding: 7px 18px; border-radius: 8px; font: 600 13px var(--sans);
    color: var(--ink-2); cursor: pointer; transition: all .15s; }
  .seg button.active { background: var(--card); color: var(--ink); box-shadow: 0 1px 3px rgba(31,30,27,.1); }

  /* ---------- master-detail ---------- */
  .split { display: grid; grid-template-columns: 290px 1fr; gap: 18px; align-items: start; }
  .browser { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .browser .search { padding: 12px; border-bottom: 1px solid var(--line); }
  .browser .search input { font-family: var(--sans); font-size: 13px; padding: 8px 12px; }
  .browser .entries { max-height: 58vh; overflow-y: auto; padding: 6px; }
  .entry { display: block; width: 100%; text-align: left; background: none; border: none; border-radius: 8px;
    padding: 9px 12px; cursor: pointer; font: inherit; color: var(--ink); transition: background .12s; }
  .entry:hover { background: #F4F2EB; }
  .entry.active { background: var(--accent-soft); }
  .entry .name { font-weight: 600; font-size: 13px; }
  .entry .desc { color: var(--ink-2); font-size: 11.5px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .entry-cat { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-2); padding: 12px 12px 4px; }
  .browser .foot { padding: 10px 12px; border-top: 1px solid var(--line); display: flex; gap: 8px; }
  .browser .foot input { font-family: var(--sans); font-size: 12.5px; padding: 7px 10px; }
  .browser .foot .btn { padding: 7px 13px; white-space: nowrap; }
  .detail h3 { font-family: var(--serif); font-weight: 500; font-size: 19px; margin: 0; }
  .detail .where { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); margin: 3px 0 14px; }
  .empty { text-align: center; color: var(--ink-2); padding: 70px 20px; }
  .empty .big { font-family: var(--serif); font-size: 19px; color: var(--ink); margin-bottom: 6px; }

  /* ---------- file chips ---------- */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 12px; }
  .seg-chip { border: 1px solid var(--line-2); background: var(--card); color: var(--ink-2); border-radius: 99px;
    padding: 4px 13px; font: 600 12px var(--sans); cursor: pointer; transition: all .12s; }
  .seg-chip:hover { border-color: var(--ink-2); color: var(--ink); }
  .seg-chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-deep); }

  /* ---------- paths ---------- */
  .path-row { padding: 16px 0; border-bottom: 1px solid var(--line); }
  .path-row:last-child { border-bottom: none; }
  .path-row .lbl { font-weight: 600; font-size: 13.5px; margin-bottom: 2px; }
  .path-row .why { color: var(--ink-2); font-size: 12.5px; margin-bottom: 9px; }
  .path-row input { font-size: 12.5px; padding: 9px 12px; }
  .path-row .resolved { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); margin-top: 6px; }
  .path-row .resolved b { color: var(--green); font-weight: 600; }

  /* ---------- toasts ---------- */
  .toasts { position: fixed; right: 22px; bottom: 22px; display: flex; flex-direction: column; gap: 9px; z-index: 50; }
  .toast { background: var(--side); color: #F5F3EC; border-radius: 10px; padding: 11px 17px; font-size: 13px;
    box-shadow: 0 8px 28px rgba(31,30,27,.28); animation: rise .2s ease-out; max-width: 380px; }
  .toast.err { background: var(--red); }
  @keyframes rise { from { opacity: 0; transform: translateY(8px);} to { opacity: 1; transform: none;} }

  /* tablet: narrow the rail, single-column master/detail */
  @media (max-width: 900px) {
    .app { grid-template-columns: 200px 1fr; }
    .main { padding: 26px 22px 56px; }
    .split { grid-template-columns: 1fr; }
  }

  /* phone / small tablet: sidebar becomes a sticky top app-bar */
  @media (max-width: 760px) {
    /* auto top-bar row + content row — without explicit rows the grid's
       default align-content:stretch balloons the bar to fill the viewport */
    .app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }

    aside {
      position: sticky; top: 0; z-index: 40; height: auto;
      display: grid; grid-template-columns: 1fr auto;
      grid-template-areas: "brand actions" "nav nav";
      align-items: center; gap: 8px;
      padding: 10px 12px 8px;
      box-shadow: 0 2px 12px rgba(31,30,27,.22);
    }
    .brand { grid-area: brand; padding: 0 2px; }
    .brand .mark { font-size: 17px; }

    /* horizontally-scrollable nav strip, bled to the screen edges */
    nav {
      grid-area: nav; flex-direction: row; flex-wrap: nowrap;
      gap: 4px; overflow-x: auto; overscroll-behavior-x: contain;
      -webkit-overflow-scrolling: touch; scrollbar-width: none;
      margin: 0 -12px; padding: 2px 12px;
    }
    nav::-webkit-scrollbar { display: none; }
    nav a { flex: 0 0 auto; white-space: nowrap; padding: 8px 13px; }

    /* compact icon-only actions in the top-right; status text hidden */
    .side-foot { grid-area: actions; margin: 0; padding: 0; display: flex; gap: 8px; }
    .side-foot .side-meta { display: none; }
    .restart-btn { width: auto; margin: 0 !important; padding: 8px 11px; font-size: 12px; }
    .restart-btn .lbl { display: none; }
    .restart-btn .rico { font-size: 14px; }

    .main { padding: 18px 14px 48px; max-width: none; }
    .page-head { margin-bottom: 16px; }
    .page-head h1 { font-size: 22px; }

    .stat-grid { grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
    .card { padding: 16px; }

    .browser .entries { max-height: 42vh; }
    .browser .foot { flex-wrap: wrap; }

    .editor-bar { flex-wrap: wrap; gap: 10px; }
    textarea, textarea.tall { min-height: 50vh; }

    /* long mono paths must wrap, not force a horizontal scroll */
    .where, .resolved, .detail .where { word-break: break-word; overflow-wrap: anywhere; }

    .toasts { left: 12px; right: 12px; bottom: 12px; }
    .toast { max-width: none; }
  }

  /* very narrow: one stat card per row */
  @media (max-width: 380px) {
    .stat-grid { grid-template-columns: 1fr; }
    .brand .mark { font-size: 16px; }
  }
</style>
</head>
<body>
<div class="app">
  <aside>
    <div class="brand"><span class="dot" id="livedot"></span><span class="mark">OpenIntel</span></div>
    <div class="bot-picker" id="bot-picker" style="display:none;padding:6px 10px">
      <label style="font-size:11px;opacity:.6;display:block;margin-bottom:2px">Agent</label>
      <select id="bot-select" onchange="onBotChange()" style="width:100%;padding:5px 6px;border-radius:6px;background:#1a1a1a;color:inherit;border:1px solid #333;font-size:12px"></select>
    </div>
    <nav id="nav">
      <a href="#/overview" data-page="overview"><span class="ico">◈</span>Overview</a>
      <a href="#/persona" data-page="persona"><span class="ico">✦</span>Persona</a>
      <a href="#/projects" data-page="projects"><span class="ico">▤</span>Projects</a>
      <a href="#/skills" data-page="skills"><span class="ico">⚒</span>Skills</a>
      <a href="#/platforms" data-page="platforms"><span class="ico">⇄</span>Platforms</a>
      <a href="#/config" data-page="config"><span class="ico">⌘</span>Config</a>
      <a href="#/paths" data-page="paths"><span class="ico">⛕</span>Paths</a>
      <a href="#/logs" data-page="logs"><span class="ico">☰</span>Logs</a>
    </nav>
    <div class="side-foot">
      <div class="side-meta" id="sidemeta">—</div>
      <button class="restart-btn" style="margin-bottom:8px" title="Update &amp; restart" onclick="updateBot()"><span class="rico">↑</span><span class="lbl"> Update &amp; restart</span></button>
      <button class="restart-btn" title="Restart bot" onclick="restartBot()"><span class="rico">⟳</span><span class="lbl"> Restart bot</span></button>
    </div>
  </aside>

  <div class="main">
    <!-- ============ OVERVIEW ============ -->
    <section data-page="overview">
      <div class="page-head"><h1>Overview</h1><p>What the agent is doing right now.</p></div>
      <div class="stat-grid" id="stats"></div>
      <div class="card" style="margin-bottom:16px"><div class="page-head" style="margin-bottom:8px"><h1 style="font-size:17px">Sessions</h1></div><div class="list" id="sessions"></div></div>
      <div class="card"><div class="page-head" style="margin-bottom:8px"><h1 style="font-size:17px">Platforms</h1></div><div class="list" id="platforms"></div></div>
    </section>

    <!-- ============ PERSONA ============ -->
    <section data-page="persona" hidden>
      <div class="page-head"><h1>Persona</h1><p>Identity and guardrails injected into every session's system prompt. New sessions pick changes up automatically.</p></div>
      <div class="seg">
        <button id="seg-soul" class="active" onclick="setPersonaTab('soul')">Soul</button>
        <button id="seg-directives" onclick="setPersonaTab('directives')">Directives</button>
      </div>
      <div class="card">
        <div class="detail"><div class="where" id="persona-path"></div></div>
        <textarea id="persona-body" class="tall" spellcheck="false" oninput="markDirty('persona')"></textarea>
        <div class="editor-bar">
          <button class="btn" id="persona-save" onclick="savePersona()">Save</button>
          <span class="bar-note">Soul = who the agent is. Directives = hard behavioral rules.</span>
        </div>
      </div>
    </section>

    <!-- ============ PROJECTS ============ -->
    <section data-page="projects" hidden>
      <div class="page-head"><h1>Projects</h1><p>Each project's <code>description.md</code> is indexed into the agent's system prompt so it knows your ongoing work.</p></div>
      <div class="split">
        <div class="browser">
          <div class="search"><input type="text" id="projects-filter" placeholder="Filter projects…" oninput="renderBrowser('projects')"></div>
          <div class="entries" id="projects-list"></div>
          <div class="foot"><input type="text" id="projects-new" placeholder="new-project-name"><button class="btn" onclick="createEntry('projects')">New</button></div>
        </div>
        <div class="card detail" id="projects-detail"></div>
      </div>
    </section>

    <!-- ============ SKILLS ============ -->
    <section data-page="skills" hidden>
      <div class="page-head"><h1>Skills</h1><p>Reusable playbooks (<code>SKILL.md</code>) listed in the agent's skills index. Supports flat and <code>category/skill</code> layouts.</p></div>
      <div class="split">
        <div class="browser">
          <div class="search"><input type="text" id="skills-filter" placeholder="Filter skills…" oninput="renderBrowser('skills')"></div>
          <div class="entries" id="skills-list"></div>
          <div class="foot"><input type="text" id="skills-new" placeholder="category/new-skill"><button class="btn" onclick="createEntry('skills')">New</button></div>
        </div>
        <div class="card detail" id="skills-detail"></div>
      </div>
    </section>

    <!-- ============ PLATFORMS ============ -->
    <section data-page="platforms" hidden>
      <div class="page-head"><h1>Platforms</h1><p>Connect the agent to Mattermost or Slack — credentials are validated live before saving. No terminal needed.</p></div>
      <div class="card" style="margin-bottom:16px">
        <div class="page-head" style="margin-bottom:8px"><h1 style="font-size:17px">Connected</h1></div>
        <div class="list" id="platform-list"></div>
      </div>
      <div class="card">
        <div class="page-head" style="margin-bottom:12px"><h1 style="font-size:17px">Add a platform</h1></div>
        <div class="seg">
          <button id="seg-mattermost" class="active" onclick="setPlatformType('mattermost')">Mattermost</button>
          <button id="seg-slack" onclick="setPlatformType('slack')">Slack</button>
          <button id="seg-discord" onclick="setPlatformType('discord')">Discord</button>
        </div>
        <div id="pf-help-mattermost" class="bar-note" style="margin-bottom:14px;line-height:1.7">
          Create the bot: System Console → Integrations → Bot Accounts (enable) → Integrations → Bot Accounts → <b>Add Bot Account</b> → copy the token. Then add the bot to your channel and grab the channel ID from View Info.
        </div>
        <div id="pf-help-slack" class="bar-note" style="margin-bottom:14px;line-height:1.7;display:none">
          Create an app at api.slack.com/apps → enable <b>Socket Mode</b> (App-Level Token with connections:write → xapp-…) → OAuth scopes: channels:history, channels:read, chat:write, files:read, reactions:read, reactions:write, users:read → install to workspace (Bot Token xoxb-…) → invite the bot to your channel.
        </div>
        <div id="pf-help-discord" class="bar-note" style="margin-bottom:14px;line-height:1.7;display:none">
          Create an app at discord.com/developers → Bot → Reset Token (copy it) → enable the <b>MESSAGE CONTENT INTENT</b> toggle. OAuth2 → URL Generator → scope <b>bot</b> with Send Messages, Read Message History, Add Reactions, Attach Files, Create Public Threads → open the URL to add the bot to your server. Channel ID: enable Developer Mode, right-click the channel → Copy Channel ID.
        </div>
        <div class="path-row" id="pf-url" style="border:none;padding:8px 0"><div class="lbl">Server URL</div>
          <input type="text" id="pf-field-url" placeholder="https://chat.example.com"></div>
        <div class="path-row" id="pf-token" style="border:none;padding:8px 0"><div class="lbl">Bot token</div>
          <input type="text" id="pf-field-token" placeholder="bot access token"></div>
        <div class="path-row" id="pf-botToken" style="border:none;padding:8px 0;display:none"><div class="lbl">Bot token (xoxb-…)</div>
          <input type="text" id="pf-field-botToken" placeholder="xoxb-…"></div>
        <div class="path-row" id="pf-appToken" style="border:none;padding:8px 0;display:none"><div class="lbl">App token (xapp-…)</div>
          <input type="text" id="pf-field-appToken" placeholder="xapp-…"></div>
        <div class="path-row" style="border:none;padding:8px 0"><div class="lbl">Channel ID</div>
          <input type="text" id="pf-field-channelId" placeholder="the channel the agent lives in"></div>
        <div class="path-row" style="border:none;padding:8px 0"><div class="lbl">Bot name</div>
          <input type="text" id="pf-field-botName" placeholder="the bot account's username"></div>
        <div class="path-row" style="border:none;padding:8px 0"><div class="lbl">Allowed users <span class="bar-note">(comma-separated; empty = everyone in the channel)</span></div>
          <input type="text" id="pf-field-allowedUsers" placeholder="alice, bob"></div>
        <div class="path-row" style="border:none;padding:8px 0"><div class="lbl">Display name <span class="bar-note">(optional)</span></div>
          <input type="text" id="pf-field-displayName" placeholder="My Team"></div>
        <div class="path-row" id="pf-allChannels" style="border:none;padding:8px 0;display:none">
          <label class="bar-note" style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="pf-field-allChannels" checked> Answer @mentions in every channel the bot can see (not just the home channel)
          </label></div>
        <div class="editor-bar">
          <button class="btn" id="pf-add" onclick="addPlatform()">Validate &amp; add</button>
          <span class="bar-note">Credentials are tested against the live API. After adding, hit Restart to connect.</span>
        </div>
      </div>
    </section>

    <!-- ============ CONFIG ============ -->
    <section data-page="config" hidden>
      <div class="page-head"><h1>Config</h1><p>The raw <code>config.yaml</code> — platforms, tokens, channels, modes. Saving validates the YAML; restart to apply.</p></div>
      <div class="card">
        <div class="detail"><div class="where" id="config-path"></div></div>
        <textarea id="config-body" class="tall" spellcheck="false" oninput="markDirty('config')"></textarea>
        <div class="editor-bar">
          <button class="btn" id="config-save" onclick="saveConfig()">Save</button>
          <button class="btn subtle" onclick="restartBot()">Save needs a restart to apply</button>
        </div>
      </div>
    </section>

    <!-- ============ LOGS ============ -->
    <section data-page="logs" hidden>
      <div class="page-head"><h1>Logs</h1><p>Live tail of the bot's daemon log (<code id="logs-path">~/.claude-threads/logs/bot.log</code>). Crashes land here too.</p></div>
      <div class="card">
        <div class="editor-bar" style="margin: 0 0 12px">
          <input type="text" id="logs-filter" placeholder="Filter lines…" style="max-width:280px;font-family:var(--sans);font-size:13px;padding:8px 12px" oninput="renderLogs()">
          <label class="bar-note" style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="logs-follow" checked> follow
          </label>
          <span class="bar-note" id="logs-count"></span>
        </div>
        <pre id="logs-body" style="background:#1F1E1B;color:#C9C5BA;border-radius:10px;padding:16px;font:11.5px/1.6 var(--mono);max-height:62vh;overflow:auto;margin:0;white-space:pre-wrap;word-break:break-all"></pre>
      </div>
    </section>

    <!-- ============ PATHS ============ -->
    <section data-page="paths" hidden>
      <div class="page-head"><h1>Paths</h1><p>Where the agent's content lives on this machine. Empty = automatic (legacy locations like Hermes if present, otherwise <code>~/.config/claude-threads/agent/</code>).</p></div>
      <div class="card">
        <div class="path-row"><div class="lbl">Soul</div><div class="why">Persona / identity / tone (SOUL.md)</div>
          <input type="text" id="path-soulPath" placeholder="automatic"><div class="resolved" id="res-soul"></div></div>
        <div class="path-row"><div class="lbl">Directives</div><div class="why">Read-only behavioral guardrails (DIRECTIVES.md)</div>
          <input type="text" id="path-directivesPath" placeholder="automatic"><div class="resolved" id="res-directives"></div></div>
        <div class="path-row"><div class="lbl">Projects index</div><div class="why">Directory of &lt;project&gt;/description.md files</div>
          <input type="text" id="path-projectsIndexDir" placeholder="automatic"><div class="resolved" id="res-projectsDir"></div></div>
        <div class="path-row"><div class="lbl">Skills</div><div class="why">Directory of &lt;skill&gt;/SKILL.md (or &lt;category&gt;/&lt;skill&gt;/SKILL.md) files</div>
          <input type="text" id="path-skillsDir" placeholder="automatic"><div class="resolved" id="res-skillsDir"></div></div>
        <div class="editor-bar">
          <button class="btn" onclick="savePaths()">Save paths</button>
          <span class="bar-note">Persisted to config.yaml. New sessions use them immediately; the Persona/Projects/Skills tabs follow along.</span>
        </div>
      </div>
    </section>
  </div>
</div>
<div class="toasts" id="toasts"></div>

<script>
var $ = function (id) { return document.getElementById(id); };
var state = { projects: [], skills: [], sel: { projects: null, skills: null }, personaTab: 'soul', persona: { soul: {}, directives: {} }, bot: '' };
/* Scope persona/projects/skills/paths reads+writes to the selected agent
   (a platform id) when this daemon hosts more than one bot. Empty = the
   daemon-global identity (single-bot default). */
function botQ() { return state.bot ? ('?bot=' + encodeURIComponent(state.bot)) : ''; }
function loadBots() {
  fetch('/api/bots').then(function (r) { return r.json(); }).then(function (j) {
    var bots = (j && j.bots) || [];
    // Always show the picker (even for a single bot) so it's clear WHICH
    // agent's persona/directives/skills you're viewing. It becomes a real
    // chooser the moment a second bot is added to this daemon.
    if (bots.length < 1) { $('bot-picker').style.display = 'none'; return; }
    var sel = $('bot-select');
    sel.innerHTML = bots.map(function (b) {
      return '<option value="' + b.id + '">' + (b.botName || b.id) + (b.ownIdentity ? '' : ' (shared)') + '</option>';
    }).join('');
    state.bot = bots[0].id;
    sel.value = state.bot;
    $('bot-picker').style.display = 'block';
  }).catch(function () {});
}
function onBotChange() {
  state.bot = $('bot-select').value;
  // Reload every agent-scoped view for the newly selected bot.
  loadPersona(); loadEntries('projects'); loadEntries('skills'); loadPaths();
}

/* ---------- routing ---------- */
function route() {
  var page = (location.hash || '#/overview').replace('#/', '') || 'overview';
  document.querySelectorAll('section[data-page]').forEach(function (s) { s.hidden = s.dataset.page !== page; });
  document.querySelectorAll('nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.page === page); });
}
window.addEventListener('hashchange', route);

/* ---------- toasts ---------- */
function toast(text, isErr) {
  var t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(function () { t.remove(); }, 3600);
}

/* ---------- dirty tracking ---------- */
function markDirty(which) { var b = $(which + '-save'); if (b) { b.textContent = 'Save changes'; } }
function markClean(which) { var b = $(which + '-save'); if (b) { b.textContent = 'Save'; } }

/* ---------- overview ---------- */
function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
var openSession = null;
function fmtTokens(n) { return n == null ? '—' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)); }
function sessionDetail(x) {
  var rows =
    '<div class="sub" style="margin:8px 0 2px">Model <b>' + esc(x.model || '—') + '</b> · Context <b>' + fmtTokens(x.contextTokens) +
    (x.contextWindowSize ? ' / ' + fmtTokens(x.contextWindowSize) : '') + '</b> · Cost <b>' +
    (x.totalCostUSD != null ? '$' + x.totalCostUSD.toFixed(2) : '—') + '</b></div>' +
    '<div class="sub" style="font-family:var(--mono);font-size:11px">' + esc(x.workingDir || '') + '</div>';
  var ev = (x.recentEvents || []).slice().reverse().map(function (e) {
    return '<div class="sub" style="font-family:var(--mono);font-size:11px">· [' + esc(e.type) + '] ' + esc(e.summary) + '</div>';
  }).join('');
  return '<div style="padding:4px 4px 12px 4px;border-bottom:1px solid var(--line)">' + rows +
    (ev ? '<div style="margin-top:8px">' + ev + '</div>' : '') +
    '<div class="editor-bar" style="margin-top:10px">' +
    '<button class="btn subtle" onclick="sessionAction(\\'' + esc(x.sessionId) + '\\',\\'interrupt\\')">⏸ Interrupt</button>' +
    '<button class="btn danger" onclick="sessionAction(\\'' + esc(x.sessionId) + '\\',\\'stop\\')">■ Stop session</button>' +
    '</div></div>';
}
function toggleSession(id) { openSession = openSession === id ? null : id; loadStatus(); }
function sessionAction(id, action) {
  if (action === 'stop' && !confirm('Kill this session?')) return;
  fetch('/api/sessions/' + encodeURIComponent(id).replace(/%3A/gi, ':') + '/' + action, { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) { toast(j.ok ? action + ' sent' : 'session not found', !j.ok); setTimeout(loadStatus, 800); });
}
function loadStatus() {
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    $('livedot').classList.remove('down');
    $('sidemeta').innerHTML = 'v' + esc(s.version) + ' · ' + esc((s.git && s.git.sha) || '') + '<br>' +
      esc((s.git && s.git.branch) || '') + '<br>pid ' + esc(s.pid) + ' · up ' + Math.floor(s.uptimeSeconds / 60) + ' min';
    var working = s.sessions.filter(function (x) { return x.isProcessing; }).length;
    var cost = s.sessions.reduce(function (a, x) { return a + (x.totalCostUSD || 0); }, 0);
    $('stats').innerHTML =
      '<div class="stat"><div class="k">Status</div><div class="v"><span class="pill on">● running</span></div></div>' +
      '<div class="stat"><div class="k">Version</div><div class="v">' + esc(s.version) + ' <small>' + esc((s.git && s.git.sha) || '') + '</small></div></div>' +
      '<div class="stat"><div class="k">Sessions</div><div class="v">' + s.sessions.length + ' <small>(' + working + ' working)</small></div></div>' +
      '<div class="stat"><div class="k">Session cost</div><div class="v">$' + cost.toFixed(2) + '</div></div>' +
      '<div class="stat"><div class="k">Uptime</div><div class="v">' + Math.floor(s.uptimeSeconds / 60) + '<small> min</small></div></div>';
    $('sessions').innerHTML = s.sessions.length ? s.sessions.map(function (x) {
      var head = '<div class="item" style="cursor:pointer" onclick="toggleSession(\\'' + esc(x.sessionId) + '\\')">' +
        '<div class="grow"><div class="title">' + esc(x.title || x.sessionId) + '</div>' +
        '<div class="sub">@' + esc(x.startedBy) + ' · ' + esc(x.platformId) +
        (x.totalCostUSD != null ? ' · $' + x.totalCostUSD.toFixed(2) : '') + '</div></div>' +
        '<span class="pill mode">' + esc(x.mode) + '</span>' +
        '<span class="pill ' + (x.isProcessing ? 'busy">working' : 'on">idle') + '</span></div>';
      return head + (openSession === x.sessionId ? sessionDetail(x) : '');
    }).join('') : '<div class="empty"><div class="big">No active sessions</div>Mention the bot in your channel to start one.</div>';
    $('platforms').innerHTML = s.platforms.map(function (p) {
      return '<div class="item"><div class="grow"><div class="title">' + esc(p.displayName) + '</div>' +
        '<div class="sub">' + esc(p.type) + ' · ' + esc(p.id) + '</div></div>' +
        '<span class="pill ' + (p.connected ? 'on">connected' : 'off">disconnected') + '</span></div>';
    }).join('');
    $('config-path').textContent = s.configPath;
  }).catch(function () {
    $('livedot').classList.add('down');
    $('sidemeta').textContent = 'bot unreachable — restarting?';
  });
}

/* ---------- logs ---------- */
var logLines = [];
function loadLogs() {
  if ((location.hash || '').indexOf('logs') < 0) return;
  fetch('/api/logs?lines=500').then(function (r) { return r.json(); }).then(function (j) {
    logLines = j.lines;
    $('logs-path').textContent = j.path;
    renderLogs();
  });
}
function renderLogs() {
  var q = ($('logs-filter').value || '').toLowerCase();
  var shown = q ? logLines.filter(function (l) { return l.toLowerCase().indexOf(q) >= 0; }) : logLines;
  $('logs-count').textContent = shown.length + ' lines';
  var el = $('logs-body');
  el.textContent = shown.join('\\n');
  if ($('logs-follow').checked) el.scrollTop = el.scrollHeight;
}

/* ---------- update ---------- */
function updateBot() {
  if (!confirm('Pull the latest branch, rebuild, and restart? Takes ~1-2 minutes; sessions persist and resume.')) return;
  fetch('/api/update', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (j) {
    toast(j.ok ? 'Updating — back in a minute or two' : 'Update failed: ' + (j.error || ''), !j.ok);
    if (j.ok) { $('livedot').classList.add('down'); setTimeout(function () { location.reload(); }, 75000); }
  }).catch(function () { toast('Update kicked off — bot going down to rebuild'); });
}

/* ---------- persona ---------- */
function setPersonaTab(tab) {
  state.personaTab = tab;
  $('seg-soul').classList.toggle('active', tab === 'soul');
  $('seg-directives').classList.toggle('active', tab === 'directives');
  $('persona-path').textContent = state.persona[tab].path || '';
  $('persona-body').value = state.persona[tab].content || '';
  markClean('persona');
}
function loadPersona() {
  ['soul', 'directives'].forEach(function (k) {
    fetch('/api/persona/' + k + botQ()).then(function (r) { return r.json(); }).then(function (j) {
      state.persona[k] = j;
      if (state.personaTab === k) setPersonaTab(k);
    });
  });
}
function savePersona() {
  var tab = state.personaTab;
  state.persona[tab].content = $('persona-body').value;
  fetch('/api/persona/' + tab + botQ(), { method: 'PUT', body: $('persona-body').value }).then(function (r) {
    toast(r.ok ? (tab === 'soul' ? 'Soul' : 'Directives') + ' saved — new sessions pick it up' : 'Save failed', !r.ok);
    if (r.ok) markClean('persona');
  });
}

/* ---------- config ---------- */
function loadConfig() { fetch('/api/config').then(function (r) { return r.text(); }).then(function (t) { $('config-body').value = t; markClean('config'); }); }
function saveConfig() {
  fetch('/api/config', { method: 'PUT', body: $('config-body').value })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (x) {
      toast(x.ok ? 'Config saved — restart to apply' : 'Invalid: ' + (x.j.error || 'error'), !x.ok);
      if (x.ok) markClean('config');
    });
}

/* ---------- master-detail (projects & skills) ---------- */
function loadEntries(kind) {
  fetch('/api/' + kind + botQ()).then(function (r) { return r.json(); }).then(function (j) {
    state[kind] = j.entries;
    state[kind + 'Dir'] = j.dir;
    if (!state.sel[kind] && j.entries.length) state.sel[kind] = j.entries[0].name;
    renderBrowser(kind);
    renderDetail(kind);
  });
}
function entryDesc(e) {
  var m = e.content && e.content.match(/^description:\\s*(.+)$/m);
  if (m) return m[1].replace(/^['"]|['"]$/g, '');
  var line = (e.content || '').split('\\n').find(function (l) { return l.trim() && !l.startsWith('---') && !l.startsWith('#') && !l.startsWith('name:'); });
  return line ? line.trim() : '';
}
function renderBrowser(kind) {
  var q = ($(kind + '-filter').value || '').toLowerCase();
  var list = state[kind].filter(function (e) { return e.name.toLowerCase().indexOf(q) >= 0; });
  var html = '';
  var lastCat = null;
  list.forEach(function (e) {
    var parts = e.name.split('/');
    var cat = parts.length > 1 ? parts[0] : null;
    var label = parts[parts.length - 1];
    if (kind === 'skills' && cat !== lastCat) { lastCat = cat; if (cat) html += '<div class="entry-cat">' + esc(cat) + '</div>'; }
    html += '<button class="entry' + (state.sel[kind] === e.name ? ' active' : '') + '" onclick="selectEntry(\\'' + kind + '\\',\\'' + esc(e.name) + '\\')">' +
      '<div class="name">' + esc(label) + '</div>' +
      (entryDesc(e) ? '<div class="desc">' + esc(entryDesc(e)) + '</div>' : '') + '</button>';
  });
  $(kind + '-list').innerHTML = html ||
    '<div class="empty"><div class="big">Nothing here yet</div>Create your first one below.</div>';
}
function selectEntry(kind, name) {
  state.sel[kind] = name;
  if (kind === 'projects') state.projFile = null; // reset to default file
  renderBrowser(kind); renderDetail(kind);
}
function selectProjectFile(file) {
  state.projFile = file;
  var name = state.sel.projects;
  fetch('/api/projects/' + encodeURIComponent(name) + '/files/' + encodeURIComponent(file) + botQ())
    .then(function (r) { return r.json(); })
    .then(function (j) { renderDetail('projects'); $('projects-body').value = j.content || ''; });
}
function addProjectFile() {
  var f = ($('projects-newfile').value || '').trim();
  if (!f) return;
  if (!/\\.md$/i.test(f)) f += '.md';
  $('projects-newfile').value = '';
  var e = state.projects.find(function (x) { return x.name === state.sel.projects; });
  if (e && e.files.indexOf(f) < 0) e.files.push(f);
  state.projFile = f;
  renderDetail('projects');
}
function renderDetail(kind) {
  var box = $(kind + '-detail');
  var e = state[kind].find(function (x) { return x.name === state.sel[kind]; });
  if (!e) {
    box.innerHTML = '<div class="empty"><div class="big">' + (kind === 'skills' ? 'No skill selected' : 'No project selected') + '</div>Pick one from the list, or create a new one.</div>';
    return;
  }
  if (kind === 'projects') {
    var files = (e.files && e.files.length) ? e.files : ['description.md'];
    if (!state.projFile || (files.indexOf(state.projFile) < 0 && state.projFile !== null)) state.projFile = files[0];
    var cur = state.projFile;
    var chips = files.map(function (f) {
      return '<button class="seg-chip' + (f === cur ? ' active' : '') + '" onclick="selectProjectFile(\\'' + esc(f) + '\\')">' + esc(f) + '</button>';
    }).join('');
    box.innerHTML = '<h3>' + esc(e.name) + '</h3><div class="where">' + esc(state.projectsDir) + '/' + esc(e.name) + '/' + esc(cur) + '</div>' +
      '<div class="chips">' + chips +
      '<input type="text" id="projects-newfile" placeholder="notes.md" style="width:130px;font-family:var(--sans);font-size:12px;padding:5px 10px">' +
      '<button class="seg-chip" onclick="addProjectFile()">+ file</button></div>' +
      '<textarea id="projects-body" spellcheck="false"></textarea>' +
      '<div class="editor-bar"><button class="btn" onclick="saveEntry(\\'projects\\')">Save</button>' +
      '<button class="btn danger" onclick="deleteEntry(\\'projects\\')">Delete ' + esc(cur) + '</button></div>';
    // description.md content rides on the entry; other files load on demand.
    if (cur === 'description.md') $('projects-body').value = e.content || '';
    else selectProjectFile(cur);
    return;
  }
  box.innerHTML = '<h3>' + esc(e.name) + '</h3><div class="where">' + esc(state[kind + 'Dir']) + '/' + esc(e.name) + '/SKILL.md</div>' +
    '<textarea id="' + kind + '-body" spellcheck="false"></textarea>' +
    '<div class="editor-bar"><button class="btn" onclick="saveEntry(\\'' + kind + '\\')">Save</button>' +
    '<button class="btn danger" onclick="deleteEntry(\\'' + kind + '\\')">Delete</button></div>';
  $(kind + '-body').value = e.content || '';
}
function createEntry(kind) {
  var name = $(kind + '-new').value.trim();
  if (!name) { toast('Enter a name first', true); return; }
  state[kind].push({ name: name, content: kind === 'skills' ? '---\\nname: ' + name.split('/').pop() + '\\ndescription: \\n---\\n\\n' : '' });
  state.sel[kind] = name;
  $(kind + '-new').value = '';
  renderBrowser(kind); renderDetail(kind);
}
function entryUrl(kind) {
  var name = state.sel[kind];
  if (kind === 'projects') {
    return '/api/projects/' + encodeURIComponent(name) + '/files/' + encodeURIComponent(state.projFile || 'description.md') + botQ();
  }
  return '/api/' + kind + '/' + encodeURIComponent(name).replace(/%2F/g, '/') + botQ();
}
function saveEntry(kind) {
  if (!state.sel[kind]) return;
  var label = kind === 'projects' ? state.sel[kind] + '/' + (state.projFile || 'description.md') : state.sel[kind];
  fetch(entryUrl(kind), { method: 'PUT', body: $(kind + '-body').value })
    .then(function (r) { toast(r.ok ? label + ' saved' : 'Save failed', !r.ok); if (r.ok) loadEntries(kind); });
}
function deleteEntry(kind) {
  if (!state.sel[kind]) return;
  var label = kind === 'projects' ? state.sel[kind] + '/' + (state.projFile || 'description.md') : state.sel[kind];
  if (!confirm('Delete "' + label + '"?')) return;
  fetch(entryUrl(kind), { method: 'DELETE' })
    .then(function (r) {
      toast(r.ok ? label + ' deleted' : 'Delete failed', !r.ok);
      if (kind === 'projects') state.projFile = null; else state.sel[kind] = null;
      loadEntries(kind);
    });
}

/* ---------- platforms ---------- */
var platformType = 'mattermost';
function setPlatformType(t) {
  platformType = t;
  ['mattermost', 'slack', 'discord'].forEach(function (x) { $('seg-' + x).classList.toggle('active', t === x); });
  $('pf-help-mattermost').style.display = t === 'mattermost' ? '' : 'none';
  $('pf-help-slack').style.display = t === 'slack' ? '' : 'none';
  $('pf-help-discord').style.display = t === 'discord' ? '' : 'none';
  $('pf-url').style.display = t === 'mattermost' ? '' : 'none';
  // Discord uses the same single "Bot token" field as Mattermost.
  $('pf-token').style.display = (t === 'mattermost' || t === 'discord') ? '' : 'none';
  $('pf-botToken').style.display = t === 'slack' ? '' : 'none';
  $('pf-appToken').style.display = t === 'slack' ? '' : 'none';
  $('pf-allChannels').style.display = t === 'discord' ? '' : 'none';
}
function loadPlatforms() {
  fetch('/api/platforms').then(function (r) { return r.json(); }).then(function (j) {
    $('platform-list').innerHTML = j.entries.length ? j.entries.map(function (p) {
      return '<div class="item"><div class="grow"><div class="title">' + esc(p.displayName || p.id) + '</div>' +
        '<div class="sub">' + esc(p.type) + ' · @' + esc(p.botName || '') + ' · channel ' + esc(p.channelId || '') + ' · token ' + esc(p.token || '') + '</div></div>' +
        '<button class="btn danger" onclick="removePlatform(\\'' + esc(p.id) + '\\')">Remove</button></div>';
    }).join('') : '<div class="empty"><div class="big">No platforms yet</div>Add one below and the agent comes online after a restart.</div>';
  });
}
function removePlatform(id) {
  if (!confirm('Remove platform "' + id + '"? The bot disconnects from it on next restart.')) return;
  fetch('/api/platforms/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function (j) { toast(j.ok ? id + ' removed — restart to apply' : 'Failed: ' + (j.error || ''), !j.ok); loadPlatforms(); });
}
function addPlatform() {
  var fields = ['url', 'token', 'botToken', 'appToken', 'channelId', 'botName', 'allowedUsers', 'displayName'];
  var body = { type: platformType };
  fields.forEach(function (f) { body[f] = ($('pf-field-' + f).value || '').trim(); });
  body.allChannels = $('pf-field-allChannels').checked ? 'true' : 'false';
  var btn = $('pf-add');
  btn.disabled = true; btn.textContent = 'Validating…';
  fetch('/api/platforms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (x) {
      btn.disabled = false; btn.textContent = 'Validate & add';
      if (x.ok) {
        var v = x.j.validated || {};
        toast('Connected as @' + (v.botUsername || body.botName) + (v.channelName ? ' in #' + v.channelName : '') + ' — restart the bot to go live');
        fields.forEach(function (f) { $('pf-field-' + f).value = ''; });
        loadPlatforms(); loadConfig();
      } else {
        toast('Validation failed: ' + (x.j.error || 'unknown error'), true);
      }
    })
    .catch(function () { btn.disabled = false; btn.textContent = 'Validate & add'; toast('Request failed', true); });
}

/* ---------- paths ---------- */
var PATH_KEYS = [['soulPath', 'soul'], ['directivesPath', 'directives'], ['projectsIndexDir', 'projectsDir'], ['skillsDir', 'skillsDir']];
function loadPaths() {
  fetch('/api/paths' + botQ()).then(function (r) { return r.json(); }).then(function (j) {
    PATH_KEYS.forEach(function (pair) {
      $('path-' + pair[0]).value = j.configured[pair[0]] || '';
      $('res-' + pair[1]).innerHTML = 'resolves to <b>' + esc(j.resolved[pair[1]]) + '</b>';
    });
  });
}
function savePaths() {
  var body = {};
  PATH_KEYS.forEach(function (pair) { body[pair[0]] = $('path-' + pair[0]).value.trim(); });
  fetch('/api/paths', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (x) {
      toast(x.ok ? 'Paths saved' : 'Failed: ' + (x.j.error || 'error'), !x.ok);
      if (x.ok) { loadPaths(); loadPersona(); loadEntries('projects'); loadEntries('skills'); }
    });
}

/* ---------- restart ---------- */
function restartBot() {
  if (!confirm('Restart the bot? Active sessions persist and resume.')) return;
  fetch('/api/restart', { method: 'POST' }).catch(function () {});
  toast('Restarting — back in ~10 seconds');
  $('livedot').classList.add('down');
  setTimeout(function () { location.reload(); }, 12000);
}

/* ---------- cmd+s ---------- */
document.addEventListener('keydown', function (ev) {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') {
    ev.preventDefault();
    var page = (location.hash || '#/overview').replace('#/', '');
    if (page === 'persona') savePersona();
    else if (page === 'config') saveConfig();
    else if (page === 'projects') saveEntry('projects');
    else if (page === 'skills') saveEntry('skills');
    else if (page === 'paths') savePaths();
  }
});

route();
loadStatus(); setInterval(loadStatus, 5000);
loadLogs(); setInterval(loadLogs, 3000);
window.addEventListener('hashchange', loadLogs);
loadBots(); loadPersona(); loadConfig(); loadEntries('projects'); loadEntries('skills'); loadPaths(); loadPlatforms();
</script>
</body>
</html>`;
