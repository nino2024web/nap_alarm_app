// app/javascript/controllers/alarm_controller.js
import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static values = {
    endsAt: Number,
    duration: Number,
    musicUrl: String,
    ringSeconds: Number,
  };
  static targets = [
    "display",
    "audio",
    "startBtn",
    "pauseBtn",
    "ytPlayer",
    "ytModal",
    "ytPlayerMount",
    "ytHint",
  ];

  connect() {
    // 状態
    this._timer = null;
    this._paused = true;
    this._wakeLock = null;
    this._ctx = null;
    this._osc = null;
    this._origTitle = null;
    this._titleBlinker = null;
    this._ringing = false;
    this._ringStopTimeout = null;
    this._ytPrepared = false;
    this._ytPlayer = null;
    this._ytPrompt = null;
    this._beepToken = null;

    // 音量
    const saved = parseFloat(localStorage.getItem("nap_volume") || "1");
    this._volume = Number.isFinite(saved) ? Math.min(Math.max(saved, 0), 1) : 1;
    try {
      this.audioTarget.volume = this._volume;
    } catch {}

    // 初期表示
    const dur =
      Number.isFinite(this.durationValue) && this.durationValue > 0
        ? this.durationValue
        : null;
    const end =
      Number.isFinite(this.endsAtValue) && this.endsAtValue > 0
        ? this.endsAtValue
        : null;
    this._initialMs = dur ?? Math.max(0, end ? end - Date.now() : 0);
    if (!Number.isFinite(this._initialMs) || this._initialMs < 0)
      this._initialMs = 0;

    this._remainingMs = this._initialMs;
    this._render(this._remainingMs);

    // Audio 初期化（YouTube URLなら <audio> は空にする）
    this.audioTarget.loop = true;
    if (this.hasMusicUrlValue) {
      const raw = (this.musicUrlValue || "").trim();
      this.audioTarget.src = this._isYoutubeUrl(raw) ? "" : raw;
    }

    // 復帰時の Wake Lock
    this._reacquireWakeLock = async () => {
      if (document.visibilityState === "visible" && !this._paused) {
        await this._requestWakeLock();
      }
    };

    // 離脱ガード
    this._beforeUnload = (e) => {
      if (this._paused) return;
      e.preventDefault();
      e.returnValue = "アラーム作動中です。離れてもよいですか？";
      return e.returnValue;
    };

    // キー操作
    this._onKeydown = (e) => {
      const t = e.target;
      const typing =
        t && t.closest('input,textarea,select,[contenteditable="true"]');
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;

      if (e.code === "KeyS" || e.key === "s" || e.key === "S") {
        e.preventDefault();
        this.snooze(5);
      }
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        if (this._ringing) {
          this.stop();
          return;
        }
        if (this._paused) this.start();
        else this.pause();
      }
      if (e.code === "Escape" || e.key === "Escape") {
        e.preventDefault();
        if (this._ringing || this._remainingMs <= 0) {
          this.stop();
        } else {
          this._stopSound();
          this._stopAlerts();
        }
      }
    };
    window.addEventListener("keydown", this._onKeydown, { capture: true });
    document.addEventListener("visibilitychange", this._reacquireWakeLock);

    if (this._initialMs > 0) this.start();
  }

  // ====== ライフサイクル ======
  disconnect() {
    this._clear();
    this._unbindBeforeUnload();
    window.removeEventListener("keydown", this._onKeydown, { capture: true });
    document.removeEventListener("visibilitychange", this._reacquireWakeLock);
    this._releaseWakeLock();
    this._stopAlerts();
    this._stopSound();
    this._destroyYT();
  }

  // ====== 操作 ======
  async start() {
    if (!this._paused || this._remainingMs <= 0) return;
    this._paused = false;
    this._endsAtMs = Date.now() + this._remainingMs;

    this._clear();
    this._tick();
    this._timer = setInterval(() => this._tick(), 200);

    await this._unlockAudio(); // 自動再生対策
    this._bindBeforeUnload();
    await this._requestWakeLock();
    this._setRingingUI(false);
  }

  async pause() {
    if (this._paused) return;
    this._paused = true;
    this._clear();
    this._remainingMs = Math.max(0, this._endsAtMs - Date.now());
    this._render(this._remainingMs);
    this._unbindBeforeUnload();
    await this._releaseWakeLock();
    this._stopAlerts();
  }

  async reset() {
    this._paused = true;
    this._clear(); // タイマー類クリア
    this._cancelBeepLoop(); // 音を全部止める
    if (this._ringStopTimeout) {
      // ← 鳴動上限のタイマー解除
      clearTimeout(this._ringStopTimeout);
      this._ringStopTimeout = null;
    }
    this._stopSound();

    this._destroyYT();
    this._closeYTPrompt();

    // UIと環境後始末
    this._unbindBeforeUnload();
    await this._releaseWakeLock();
    this._stopAlerts();
    this._setRingingUI(false);

    // 時間を初期値へ
    this._remainingMs = this._initialMs ?? 0;
    this._render(this._remainingMs);
  }

  stop() {
    this._clear();
    this._cancelBeepLoop();
    if (this._ringStopTimeout) {
      clearTimeout(this._ringStopTimeout);
      this._ringStopTimeout = null;
    }
    // 可視プレイヤー＆準備プレイヤーを停止
    this.closeYt();
    if (this._ytPlayer) {
      try {
        this._ytPlayer.stopVideo();
      } catch {}
    }
    this._ytPrepared = false;
    this._stopSound();
    this._stopAlerts();
    this._ringing = false;
    this._paused = true;
    this._unbindBeforeUnload();
    this._releaseWakeLock();
    this._setRingingUI(false);
    this._closeYT();
  }

  snooze(min = 5) {
    const n = Number(min);
    const addMs = (Number.isFinite(n) && n > 0 ? n : 5) * 60000;

    this._cancelBeepLoop();
    this._stopSound();
    this._stopAlerts();
    this._ringing = false;

    this._paused = false;
    this._endsAtMs = Date.now() + addMs;
    this._clear();
    this._tick();
    this._timer = setInterval(() => this._tick(), 200);
    this._bindBeforeUnload();
    this._requestWakeLock();
    this._setRingingUI(false);
  }

  // ====== タイマー ======
  _tick() {
    const ms = Math.max(0, this._endsAtMs - Date.now());
    this._remainingMs = ms;
    this._render(ms);
    if (ms <= 0) {
      this._clear();
      this._ring();
    }
  }

  _render(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    this.displayTarget.textContent = [h, m, s]
      .map((v) => String(v).padStart(2, "0"))
      .join(":");
  }

  // ====== 鳴動 ======
  async _ring() {
    try {
      await this._ensureAudioUnlocked();
      const url = (this.musicUrlValue || "").trim();
      const isYT = this._isYoutubeUrl(url);
      let started = false;

      if (!url) {
        // 音源なし → 30秒ビープ
        this._startBeepLoop(this._ringDurationMsForNonYouTube());
        started = true;
        this._scheduleStopAfter(this._ringDurationMsForNonYouTube());
      } else if (isYT) {
        const ok = await this._playYouTubeVisible(url); // ←モーダルで再生
        if (!ok) {
          // 埋め込み不可 → フォールバック音（30秒）に退避
          this._startBeepLoop(this._ringDurationMsForNonYouTube());
          this._scheduleStopAfter(this._ringDurationMsForNonYouTube());
        } else {
          this._scheduleStopAfter(15 * 60 * 1000);
        }
        started = true;
      } else {
        // asset/mp3 は 30秒だけループ
        this.audioTarget.loop = true;
        this.audioTarget.src = url;
        this.audioTarget.volume = this._volume ?? 1;
        await this.audioTarget.play();
        started = true;
        this._scheduleStopAfter(this._ringDurationMsForNonYouTube());
      }

      if (started) {
        await this._notifyComplete();
        this._ringing = true;
        this._setRingingUI(true);
      }
    } catch {
      this.displayTarget.textContent = "再生ボタン押して！";
    }
  }

  _setRingingUI(isRinging) {
    const startEl = this.hasStartBtnTarget ? this.startBtnTarget : null;
    const pauseEl = this.hasPauseBtnTarget ? this.pauseBtnTarget : null;
    if (!startEl || !pauseEl) return;

    if (isRinging) {
      startEl.textContent = "スヌーズ(+5分)";
      startEl.setAttribute("data-action", "alarm#snooze");
      pauseEl.textContent = "停止";
      pauseEl.setAttribute("data-action", "alarm#stop");
    } else {
      startEl.textContent = "開始/再開";
      startEl.setAttribute("data-action", "alarm#start");
      pauseEl.textContent = "一時停止";
      pauseEl.setAttribute("data-action", "alarm#pause");
    }
  }

  _clear() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ====== ビープ ======
  _startBeepLoop(totalMs) {
    const token = { id: Date.now() };
    this._beepToken = token;
    this._beepLoopFor(totalMs, token); // 非同期並行
  }

  _cancelBeepLoop() {
    this._beepToken = null;
    this._stopSound(); // 直近の鳴動も止める
  }

  async _beepLoopFor(totalMs, token) {
    const end = Date.now() + totalMs;
    while (Date.now() < end && token === this._beepToken) {
      await this._beepOnce(250, 1000);
      if (token !== this._beepToken) break;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async _beepOnce(duration = 800, freq = 880) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._ctx = ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const v = this._volume ?? 1;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3 * v, ctx.currentTime + 0.01);
    osc.start();
    this._osc = osc;
    await new Promise((res) => setTimeout(res, duration));
    try {
      osc.stop();
    } catch {}
    try {
      osc.disconnect();
    } catch {}
    try {
      gain.disconnect();
    } catch {}
    await ctx.close();
    this._osc = null;
    this._ctx = null;
  }

  _stopSound() {
    try {
      if (this.hasAudioTarget) {
        const a = this.audioTarget;
        a.pause();
        a.loop = false;
        a.currentTime = 0;
        a.load();
      }
    } catch {}

    if (this._osc) {
      try {
        this._osc.stop();
      } catch {}
      try {
        this._osc.disconnect();
      } catch {}
      this._osc = null;
    }
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
    }

    this._ringing = false;
    if (this._remainingMs <= 0) {
      this._unbindBeforeUnload();
      this._paused = true;
    }
  }

  // ====== Wake Lock / 通知 ======
  async _requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        if (this._wakeLock) {
          try {
            await this._wakeLock.release();
          } catch {}
          this._wakeLock = null;
        }
        this._wakeLock = await navigator.wakeLock.request("screen");
        this._wakeLock.addEventListener("release", () => {});
      }
    } catch (e) {
      console.warn("Wake Lock 拒否/失敗:", e);
    }
  }
  async _releaseWakeLock() {
    try {
      await this._wakeLock?.release();
    } catch {}
    this._wakeLock = null;
  }

  async _notifyComplete() {
    try {
      if ("Notification" in window) {
        if (Notification.permission === "default") {
          try {
            await Notification.requestPermission();
          } catch {}
        }
        if (
          Notification.permission === "granted" &&
          document.visibilityState === "hidden"
        ) {
          new Notification("⏰ アラーム", { body: "時間だよ", silent: false });
        }
      }
    } catch {}
    try {
      navigator.vibrate?.([400, 120, 400, 120, 400]);
    } catch {}

    if (!this._origTitle) this._origTitle = document.title;
    this._stopAlerts();
    this._titleBlinker = setInterval(() => {
      document.title = document.title.startsWith("⏰")
        ? this._origTitle
        : "⏰ 時間だよ";
    }, 900);
    window.addEventListener("focus", () => this._stopAlerts(), { once: true });
  }

  _stopAlerts() {
    if (this._titleBlinker) {
      clearInterval(this._titleBlinker);
      this._titleBlinker = null;
    }
    if (this._origTitle) document.title = this._origTitle;
  }

  // ====== 自動再生対策 ======
  async _unlockAudio() {
    try {
      this._ctx =
        this._ctx || new (window.AudioContext || window.webkitAudioContext)();
      await this._ctx.resume();
    } catch {}
    if (this.hasMusicUrlValue && this.musicUrlValue.trim() !== "") {
      try {
        const a = this.audioTarget;
        a.muted = true;
        a.volume = this._volume ?? a.volume;
        await a.play(); // 許可だけ取る
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      } catch {}
    }
  }
  async _ensureAudioUnlocked() {
    return Promise.resolve();
  }

  // ====== YouTube 埋め込み ======
  async _ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) return;
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.onerror = () => rej(new Error("yt api load fail"));
      document.head.appendChild(s);
      window.onYouTubeIframeAPIReady = () => res();
      setTimeout(() => res(), 3000);
    });
  }

  async _prepareYouTube(rawUrl) {
    await this._ensureYouTubeAPI();
    const id = this._extractYouTubeId(rawUrl);
    if (!id) return false;

    const opts = {
      height: "0",
      width: "0",
      videoId: id,
      playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1, mute: 1 },
      events: {
        onReady: (e) => {
          const ifr = e.target.getIframe?.();
          if (ifr) {
            ifr.setAttribute("allow", "autoplay; fullscreen; encrypted-media");
            ifr.setAttribute("playsinline", "1");
            ifr.setAttribute("allowfullscreen", "1");
          }
          try {
            e.target.playVideo();
          } catch {}
        },
        onError: (e) => {
          this._ytPrepared = false;
          this._ytError = e?.data;
        },
      },
    };

    if (!this._ytPlayer) {
      this._ytPlayer = new YT.Player(
        this.hasYtPlayerTarget ? this.ytPlayerTarget : "yt-player",
        opts
      );
      const ok = await new Promise((res) => {
        let t = 0;
        const tick = () => {
          try {
            if (this._ytPlayer.getPlayerState) return res(true);
          } catch {}
          if (t++ > 40) return res(false);
          setTimeout(tick, 50);
        };
        tick();
      });
      if (!ok) return false;
    } else {
      try {
        this._ytPlayer.loadVideoById(id);
      } catch {
        return false;
      }
    }

    try {
      this._ytPlayer.mute();
      this._ytPlayer.playVideo();
    } catch {}
    this._ytPrepared = true;
    return true;
  }

  async _unmutePreparedYouTube() {
    try {
      this._ytPlayer.seekTo(0, true);
      this._ytPlayer.unMute();
      this._ytPlayer.playVideo();
    } catch {
      return false;
    }
    const ok = await new Promise((res) => {
      const t0 = performance.now();
      (function tick() {
        try {
          if (this._ytPlayer.getPlayerState() === YT.PlayerState.PLAYING)
            return res(true);
        } catch {}
        if (performance.now() - t0 > 2000) return res(false);
        requestAnimationFrame(tick.bind(this));
      }).call(this);
    });
    return ok;
  }

  _destroyYT() {
    try {
      this._ytPlayer?.stopVideo();
    } catch {}
    try {
      this._ytPlayer?.destroy();
    } catch {}
    this._ytPlayer = null;
    this._ytPrepared = false;
    this._closeYTPrompt();
  }

  // プロンプト（同タブでの明示クリック）
  _showYTPrompt(onPlay) {
    if (this._ytPrompt) return;
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,.35)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "9999",
    });
    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "#fff",
      padding: "14px 18px",
      borderRadius: "10px",
      boxShadow: "0 10px 30px rgba(0,0,0,.2)",
      maxWidth: "92%",
      textAlign: "center",
    });
    card.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;">このタブで再生する</div>
      <div style="font-size:12px;color:#555;margin-bottom:12px;">自動再生がブロックされたから、押してね</div>
      <button id="yt-go" style="padding:.5rem 1rem;border:1px solid #60a5fa;border-radius:8px;background:#dbeafe;color:#1d4ed8;">再生</button>
      <button id="yt-cancel" style="margin-left:.5rem;padding:.5rem 1rem;border:1px solid #ddd;border-radius:8px;background:#fff;">閉じる</button>
    `;
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    this._ytPrompt = wrap;

    const play = async () => {
      try {
        await onPlay?.();
      } finally {
        this._closeYTPrompt();
      }
    };
    const close = () => this._closeYTPrompt();
    card
      .querySelector("#yt-go")
      ?.addEventListener("click", play, { once: true });
    card
      .querySelector("#yt-cancel")
      ?.addEventListener("click", close, { once: true });
  }
  _closeYTPrompt() {
    this._ytPrompt?.remove();
    this._ytPrompt = null;
  }

  // ====== 小物 ======
  _ringDurationMsForNonYouTube() {
    const s =
      this.hasRingSecondsValue && this.ringSecondsValue > 0
        ? this.ringSecondsValue
        : 30;
    return s * 1000;
  }
  _scheduleStopAfter(ms) {
    if (this._ringStopTimeout) clearTimeout(this._ringStopTimeout);
    this._ringStopTimeout = setTimeout(() => this.stop(), ms);
  }

  _isYoutubeUrl(u) {
    try {
      const x = new URL(u);
      return [
        "www.youtube.com",
        "youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
      ].includes(x.hostname);
    } catch {
      return false;
    }
  }
  _extractYouTubeId(u) {
    try {
      const x = new URL(u);
      const h = x.hostname.toLowerCase();
      if (h === "youtu.be") return x.pathname.slice(1);
      if (x.pathname.startsWith("/shorts/")) return x.pathname.split("/")[2];
      if (x.pathname.startsWith("/embed/")) return x.pathname.split("/")[2];
      return x.searchParams.get("v");
    } catch {
      return null;
    }
  }

  openYt() {
    this.ytModalTarget.classList.remove("hidden");
    this.ytModalTarget.classList.add("flex");
  }

  closeYt() {
    try {
      this._yt?.stopVideo();
    } catch {}
    try {
      this._yt?.destroy();
    } catch {}
    this._yt = null;
    this.ytModalTarget.classList.add("hidden");
    this.ytModalTarget.classList.remove("flex");
  }

  async _playYouTubeVisible(rawUrl) {
    await this._ensureYouTubeAPI();
    const id = this._extractYouTubeId(rawUrl);
    if (!id) return false;

    // 既存破棄→開く
    this.closeYt();
    this.openYt();

    this._yt = new YT.Player(this.ytPlayerMountTarget, {
      width: 360,
      height: 203,
      videoId: id,
      playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1 },
      events: {
        onReady: (e) => {
          try {
            e.target.playVideo();
          } catch {}
        },
        onError: () => this.closeYt(),
      },
    });
    return true;
  }

  _normalizeToYouTubeWatch(u) {
    try {
      const x = new URL(u);
      if (x.hostname === "youtu.be")
        return `https://www.youtube.com/watch?v=${x.pathname.slice(1)}`;
      if (
        x.hostname === "music.youtube.com" ||
        x.hostname === "m.youtube.com"
      ) {
        const v = x.searchParams.get("v");
        if (v) return `https://www.youtube.com/watch?v=${v}`;
      }
      return u;
    } catch {
      return u;
    }
  }

  // デバッグ用（任意で使う）
  async testSound() {
    try {
      await this._ensureAudioUnlocked();
      if (this.hasMusicUrlValue && this.musicUrlValue.trim() !== "") {
        this._stopSound();
        this.audioTarget.volume = this._volume ?? 1;
        await this.audioTarget.play();
      } else {
        await this._beepOnce();
      }
    } catch (e) {
      alert("再生がブロックされたかも。別のURLやブラウザを試して。");
      console.error(e);
    }
  }

  _bindBeforeUnload() {
    window.addEventListener("beforeunload", this._beforeUnload, {
      capture: true,
    });
  }
  _unbindBeforeUnload() {
    window.removeEventListener("beforeunload", this._beforeUnload, {
      capture: true,
    });
  }
}
