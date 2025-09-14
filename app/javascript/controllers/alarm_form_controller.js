import { Controller } from "@hotwired/stimulus";

const HISTORY_KEY = "nap_alarm_history";
const VOL_KEY = "nap_volume";

export default class extends Controller {
  static targets = [
    "source","urlRow","musicUrl","ytMeta","ytTitle","historyList",
    "volume","volLabel","hours","minutes","seconds","testHint","ytTest",
  ];

  connect() {
    this._audio = new Audio();
    this._audio.preload = "auto";
    this._audio.loop = false;

    const saved = parseFloat(localStorage.getItem(VOL_KEY) || "1");
    const v = Number.isFinite(saved) ? Math.min(Math.max(saved, 0), 1) : 1;
    if (this.hasVolumeTarget) this.volumeTarget.value = String(v);
    if (this.hasVolLabelTarget) this.volLabelTarget.textContent = `${Math.round(v*100)}%`;
    this._audio.volume = v;

    this.sourceChanged();
    this.presetChanged();
    this._renderHistory();

    this.formEl = this.element.closest("form") || this.element.querySelector("form");
    this._onSubmit = () => { this._syncMusicUrlForSubmit(); this._saveHistoryOnSubmit(); };
    if (this.formEl) this.formEl.addEventListener("submit", this._onSubmit);

    const unlock = () => this._unlockAudio().finally(() => {
      window.removeEventListener("pointerdown", unlock, { once:true });
      window.removeEventListener("keydown", unlock, { once:true });
    });
    window.addEventListener("pointerdown", unlock, { once:true });
    window.addEventListener("keydown", unlock, { once:true });
  }

  disconnect() {
    if (this.formEl && this._onSubmit) this.formEl.removeEventListener("submit", this._onSubmit);
    this._stop();
    if (this._ctx) { try { this._ctx.close(); } catch {} this._ctx = null; }
    this._stopYouTubeTest?.();
  }

  // 送信直前の正規化：asset はURL、YouTubeは v= のみ残す
  _syncMusicUrlForSubmit() {
    if (!this.hasMusicUrlTarget) return;
    const { type, url } = this._resolveSource();
    if (type === "asset") {
      this.musicUrlTarget.value = url || "";
    } else if (type === "youtube") {
      const raw = (this.musicUrlTarget.value || "").trim();
      this.musicUrlTarget.value = this._sanitizeYouTube(raw);
    } else {
      this.musicUrlTarget.value = "";
    }
  }

  // === 時間 ===
  presetChanged() {
    const selected = new FormData(this.element.closest("form") || this.element).get("preset");
    const on = selected === "custom";
    const set = (el) => { if (!el) return; el.disabled = !on; el.classList.toggle("opacity-50", !on); };
    set(this.hoursTarget); set(this.minutesTarget); set(this.secondsTarget);
  }

  // === 音源切替（YouTubeだけ URL 欄を見せる） ===
  sourceChanged() {
    if (!this.hasSourceTarget) return;
    const [kind] = this.sourceTarget.value.split(":");
    const showUrl = kind === "youtube"; // ← MP3削除
    if (this.hasUrlRowTarget) this.urlRowTarget.hidden = !showUrl;

    if (kind === "youtube") {
      if (this.hasMusicUrlTarget) this.musicUrlTarget.placeholder = "https://www.youtube.com/watch?v=...";
      if (this.hasYtMetaTarget) {
        this.ytMetaTarget.hidden = false;
        this._debouncedFetchTitle ??= this._debounce(() => this._fetchYoutubeTitle(), 300);
        this._debouncedFetchTitle();
      }
    } else {
      if (this.hasYtMetaTarget) this.ytMetaTarget.hidden = true;
    }
    this._updateTestHint();
  }

  urlChanged() {
    if (!this.hasSourceTarget) return;
    const [kind] = this.sourceTarget.value.split(":");
    if (kind === "youtube") this._debouncedFetchTitle?.();
    this._updateTestHint();
  }

  _updateTestHint() {
    if (!this.hasTestHintTarget) return;
    const { type } = this._resolveSource();
    if (type === "asset") this.testHintTarget.textContent = "デフォルト音源を再生します";
    else if (type === "youtube") this.testHintTarget.textContent = "このタブで短時間プレビューします";
    else this.testHintTarget.textContent = "";
  }

  // === テスト再生（履歴保存なし） ===
  async testSound() {
    const { type, url } = this._resolveSource();
    if (type === "asset") {
      const ok = await this._playWithHealthcheck(url);
      if (!ok) this._beepOnce();
      return;
    }
    if (type === "youtube") {
      const raw = this.musicUrlTarget?.value?.trim();
      if (!raw) { alert("YouTube URLが空です"); return; }
      await this._playYoutubeInline(raw, { previewMs: 8000 });
    }
  }

  stopTest() { this._stop(); this._stopYouTubeTest?.(); }

  // === 音量 ===
  volumeChanged() {
    const v = this._currentVolume();
    try { localStorage.setItem(VOL_KEY, String(v)); } catch {}
    if (this.hasVolLabelTarget) this.volLabelTarget.textContent = `${Math.round(v*100)}%`;
    this._audio.volume = v;
  }

  // === YouTube 題名 ===
  async _fetchYoutubeTitle() {
    if (!this.hasMusicUrlTarget || !this.hasYtTitleTarget) return;
    const raw = this.musicUrlTarget.value?.trim();
    if (!raw) { this.ytTitleTarget.textContent = "（URL未入力）"; return; }
    if (!this._isYoutubeUrl(raw)) { this.ytTitleTarget.textContent = "（YouTubeリンクではありません）"; return; }

    const cacheKey = "na_oembed_cache";
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(cacheKey) || "{}"); } catch {}
    if (cache[raw]?.title) { this.ytTitleTarget.textContent = cache[raw].title; return; }

    this.ytTitleTarget.textContent = "取得中…";
    try {
      const norm = this._normalizeToYouTubeWatch(raw);
      const res = await fetch(`/oembed?url=${encodeURIComponent(norm)}`);
      if (!res.ok) throw new Error("oEmbed失敗");
      const data = await res.json();
      const title = data.title || "（題名不明）";
      this.ytTitleTarget.textContent = title;
      cache[raw] = { title, at: Date.now(), thumbnail_url: data.thumbnail_url };
      localStorage.setItem(cacheKey, JSON.stringify(cache));
    } catch {
      this.ytTitleTarget.textContent = "取得できませんでした";
    }
  }

  // === 履歴（送信時のみ保存） ===
  clearHistory() { localStorage.removeItem(HISTORY_KEY); this._renderHistory(); }

  _saveHistoryOnSubmit() {
    const item = {
      duration_ms: this._currentDurationMs(),
      music_url: (this.musicUrlTarget?.value || "").trim(),
      at: Date.now(),
    };
    const list = this._loadHistory();
    const key = (it) => `${it.duration_ms}|${it.music_url}`;
    const seen = new Set([key(item)]);
    const out = [item];
    for (const it of list) {
      const k = key(it); if (seen.has(k)) continue;
      seen.add(k); out.push(it); if (out.length >= 10) break;
    }
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(out)); } catch {}
    this._renderHistory();
  }

  _renderHistory() {
    if (!this.hasHistoryListTarget) return;
    const list = this._loadHistory();
    this.historyListTarget.innerHTML = "";
    if (!list.length) {
      this.historyListTarget.insertAdjacentHTML("beforeend", `<li class="text-sm text-gray-600">履歴はありません</li>`);
      return;
    }
    for (const it of list) {
      const mins = Math.floor(it.duration_ms / 60000);
      const secs = Math.floor((it.duration_ms % 60000) / 1000);
      const label = `${mins}分${secs ? secs + "秒" : ""} / ${it.music_url || "ビープ"}`;
      const li = document.createElement("li");
      li.className = "flex items-center gap-2";
      li.innerHTML = `
        <button type="button" class="inline-flex items-center justify-center rounded border px-3 py-1 hover:bg-gray-50">使う</button>
        <span class="text-sm">${label}</span>`;
      li.querySelector("button").addEventListener("click", () => this._apply(it));
      this.historyListTarget.appendChild(li);
    }
  }

  _apply(it) {
    const presets = [15,20,30,45,60];
    const totalMin = Math.round(it.duration_ms / 60000);
    const match = presets.find((m) => m === totalMin);

    if (match) {
      const r = document.querySelector(`input[name="preset"][value="${match}"]`); if (r) r.checked = true;
      const ch = document.querySelector('input[name="custom_hours"]');
      const cm = document.querySelector('input[name="custom_minutes"]');
      const cs = document.querySelector('input[name="custom_seconds"]');
      if (ch) ch.value = 0; if (cm) cm.value = 0; if (cs) cs.value = 0;
    } else {
      const r = document.querySelector('input[name="preset"][value="custom"]'); if (r) r.checked = true;
      const hours = Math.floor(it.duration_ms / 3600000);
      const minutes = Math.floor((it.duration_ms % 3600000) / 60000);
      const seconds = Math.floor((it.duration_ms % 60000) / 1000);
      const ch = document.querySelector('input[name="custom_hours"]');
      const cm = document.querySelector('input[name="custom_minutes"]');
      const cs = document.querySelector('input[name="custom_seconds"]');
      if (ch) ch.value = hours; if (cm) cm.value = minutes; if (cs) cs.value = seconds;
    }

    const mu = document.querySelector('input[name="music_url"]');
    if (mu) mu.value = it.music_url || "";
    this.presetChanged();

    if (this.hasSourceTarget) {
      const url = it.music_url || "";
      let kind = "asset";
      if (this._isYoutubeUrl(url)) kind = "youtube";
      if (kind === "asset") {
        const opts = Array.from(this.sourceTarget.options);
        const hit = opts.find((o) => o.value.startsWith("asset:") && o.value.slice(6) === url);
        if (hit) this.sourceTarget.value = hit.value;
      } else {
        this.sourceTarget.value = kind;
      }
      this.sourceChanged();
    }
  }

  _loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
    catch { return []; }
  }

  // === ボリューム ===
  _currentVolume() {
    const raw = this.hasVolumeTarget ? parseFloat(this.volumeTarget.value || "1") :
                                       parseFloat(localStorage.getItem(VOL_KEY) || "1");
    const v = Number.isFinite(raw) ? raw : 1;
    return Math.min(Math.max(v, 0), 1);
  }

  // === 再生ユーティリティ ===
  async _unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !this._ctx) { this._ctx = new AC(); if (this._ctx.state === "suspended") await this._ctx.resume(); }
      this._audio.muted = true; this._audio.src = ""; await this._audio.play().catch(() => {});
      this._audio.pause(); this._audio.muted = false;
    } catch {}
  }

  async _playWithHealthcheck(url, { timeoutMs = 4000 } = {}) {
    try {
      this._stop();
      this._audio.crossOrigin = "anonymous";
      this._audio.src = url;
      const playPromise = this._audio.play().then(() => true).catch(() => false);
      const ok = await Promise.race([ playPromise, new Promise((res) => setTimeout(() => res("timeout"), timeoutMs)) ]);
      if (ok !== true) { this._stop(); return false; }
      return true;
    } catch { return false; }
  }

  _stop() { try { this._audio.pause(); this._audio.currentTime = 0; } catch {} this._audio.src = ""; }

  _currentDurationMs() {
    const form = this.element.closest("form") || this.element;
    const checked = form.querySelector('input[name="preset"]:checked')?.value;
    if (checked && checked !== "custom") return parseInt(checked,10)*60000;

    const h = parseInt(form.querySelector('input[name="custom_hours"]')?.value || "0", 10);
    const m = parseInt(form.querySelector('input[name="custom_minutes"]')?.value || "0", 10);
    const s = parseInt(form.querySelector('input[name="custom_seconds"]')?.value || "0", 10);
    const hh = isNaN(h) ? 0 : h, mm = isNaN(m) ? 0 : m, ss = isNaN(s) ? 0 : s;
    let ms = (hh*3600 + mm*60 + ss)*1000;
    const max = 24*60*60000;
    if (ms < 0) ms = 0; if (ms > max) ms = max;
    return ms;
  }

  _resolveSource() {
    if (!this.hasSourceTarget) {
      const url = this.musicUrlTarget?.value?.trim();
      return this._isYoutubeUrl(url) ? { type:"youtube", url } : { type:"asset", url: "" };
    }
    const v = this.sourceTarget.value;
    const [kind, val] = v.split(":");
    if (kind === "asset") return { type:"asset", url: val, label: this.sourceTarget.options[this.sourceTarget.selectedIndex].text };
    if (kind === "youtube") {
      const url = this.musicUrlTarget?.value?.trim();
      const label = this.hasYtTitleTarget ? (this.ytTitleTarget.textContent || "YouTube") : "YouTube";
      return { type:"youtube", url, label };
    }
    return { type:"asset", url: val, label: "Default" };
  }

  _guessLabel(u) { try { const x = new URL(u); const file = x.pathname.split("/").pop(); return file || x.hostname; } catch { return "External"; } }

  _isYoutubeUrl(u) {
    try { const x = new URL(u);
      return ["www.youtube.com","youtube.com","m.youtube.com","music.youtube.com","youtu.be"].includes(x.hostname);
    } catch { return false; }
  }

  _normalizeToYouTubeWatch(u) {
    try {
      const x = new URL(u);
      if (x.hostname === "youtu.be") return `https://www.youtube.com/watch?v=${x.pathname.slice(1)}`;
      if (x.hostname === "music.youtube.com" || x.hostname === "m.youtube.com") {
        const v = x.searchParams.get("v"); if (v) return `https://www.youtube.com/watch?v=${v}`;
      }
      return u;
    } catch { return u; }
  }

  _sanitizeYouTube(raw) {
    try {
      const u = new URL(this._normalizeToYouTubeWatch(raw));
      const v = u.searchParams.get("v");
      u.search = ""; if (v) u.searchParams.set("v", v);
      return u.toString();
    } catch { return raw; }
  }

  // ——— YouTube 同タブプレビュー ———
  async _ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) return;
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true; s.onerror = () => rej(new Error("yt api load fail"));
      document.head.appendChild(s);
      window.onYouTubeIframeAPIReady = () => res();
      setTimeout(() => res(), 3000);
    });
  }

  _extractYouTubeId(u) {
    try {
      const x = new URL(u);
      if (x.hostname === "youtu.be") return x.pathname.slice(1);
      if (x.searchParams.get("v")) return x.searchParams.get("v");
      const m = x.pathname.match(/\/embed\/([^/?#]+)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  async _playYoutubeInline(rawUrl, { previewMs = 8000 } = {}) {
    await this._ensureYouTubeAPI();
    const id = this._extractYouTubeId(rawUrl);
    if (!id) { alert("YouTubeのURLが変だよ"); return false; }

    this._stopYouTubeTest?.();

    let mount = this.hasYtTestTarget ? this.ytTestTarget : null;
    if (!mount) {
      mount = document.createElement("div");
      mount.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;pointer-events:none;";
      this.element.appendChild(mount);
      this._ytTempMount = mount;
    }

    this._ytInline = new YT.Player(mount, {
      width: "0", height: "0", videoId: id,
      playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1, mute: 0 },
      events: {
        onReady: (e) => {
          e.target.getIframe?.().setAttribute("allow", "autoplay; encrypted-media; fullscreen");
          e.target.playVideo();
          this._ytInlineTimer = setTimeout(() => this._stopYouTubeTest(), previewMs);
        },
      },
    });
    return true;
  }

  _stopYouTubeTest() {
    try { clearTimeout(this._ytInlineTimer); } catch {}
    this._ytInlineTimer = null;
    try { this._ytInline?.stopVideo(); } catch {}
    try { this._ytInline?.destroy(); } catch {}
    this._ytInline = null;
    if (this._ytTempMount) { try { this._ytTempMount.remove(); } catch {} this._ytTempMount = null; }
  }

  _debounce(fn, ms) { let t=null; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }
}
