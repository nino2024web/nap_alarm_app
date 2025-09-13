import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static values = {
    endsAt: Number,
    duration: Number,
    musicUrl: String,
    ringSeconds: Number,
  };
  static targets = ["display", "audio", "startBtn", "pauseBtn", "ytPlayer"];

  connect() {
    // 状態
    this._timer = null;
    this._paused = true;
    this._wakeLock = null;
    this._ctx = null;
    this._osc = null;
    this._origTitle = null;
    this._titleBlinker = null;
    this._ringing = false; // いま鳴っているかどうか
    this._ringStopTimeout = null; // 自動停止用タイマー
    this._ytPrepared = false;

    // 音量の復元（UIは置かないので読むだけ）
    const saved = parseFloat(localStorage.getItem("nap_volume") || "1");
    this._volume = Number.isFinite(saved) ? Math.min(Math.max(saved, 0), 1) : 1;
    try {
      this.audioTarget.volume = this._volume;
    } catch (_) {}

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

    // Audio 初期化
    this.audioTarget.loop = true;
    if (this.hasMusicUrlValue) {
      const raw = this.musicUrlValue.trim();
      this.audioTarget.src = this._isYoutubeUrl(raw) ? "" : raw;
    }

    // 復帰時に Wake Lock を取り直す
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

    // キーボード: Space/Esc（フォーム入力中は無視）
    this._onKeydown = (e) => {
      // 入力要素や修飾キー付きはスルー
      const t = e.target;
      const typing =
        t && t.closest('input,textarea,select,[contenteditable="true"]');
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;

      // スヌーズ機能(+5分)
      if (e.code === "KeyS" || e.key === "s" || e.key === "S") {
        e.preventDefault();
        this.snooze(5);
      }

      // Space
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault(); // スクロール抑止
        if (this._ringing) {
          this.stop();
          return;
        }
        // 通常は一時停止/再開トグル
        if (this._paused) {
          this.start();
        } else {
          this.pause();
        }
      }

      // Esc = いつでも音停止（鳴動/再生の有無にかかわらず）
      if (e.code === "Escape" || e.key === "Escape") {
        e.preventDefault();
        if (this._ringing || this._remainingMs <= 0) {
          this.stop(); // UI/ガード/ロックも整理
        } else {
          this._stopSound(); // 誤再生の強制停止だけ
          this._stopAlerts();
        }
      }
    };
    window.addEventListener("keydown", this._onKeydown, { capture: true });

    document.addEventListener("visibilitychange", this._reacquireWakeLock);

    if (this._initialMs > 0) {
      this.start();
    }
  }

  async _prepareYouTube(rawUrl) {
    await this._ensureYouTubeAPI();
    const id = this._extractYouTubeId(rawUrl);
    if (!id) return false;
    if (!this._ytPlayer) {
      this._ytPlayer = new YT.Player(
        this.hasYtPlayerTarget ? this.ytPlayerTarget : "yt-player",
        {
          height: "0",
          width: "0",
          videoId: id,
          playerVars: {
            autoplay: 1,
            controls: 0,
            rel: 0,
            playsinline: 1,
            mute: 1,
          },
        }
      );
      await new Promise((res) => {
        let t = 0;
        (function tick() {
          try {
            if (this._ytPlayer.getPlayerState) return res();
          } catch {}
          if (t++ > 40) return res();
          setTimeout(tick.bind(this), 50);
        }).call(this);
      });
    } else {
      this._ytPlayer.loadVideoById(id);
    }
    try {
      this._ytPlayer.mute();
      this._ytPlayer.playVideo();
    } catch (_) {}
    this._ytPrepared = true;
    return true;
  }

  async _unmutePreparedYouTube() {
    try {
      this._ytPlayer.seekTo(0, true);
      this._ytPlayer.unMute();
      this._ytPlayer.playVideo();
    } catch (_) {
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

  stop() {
    if (this._ringStopTimeout) {
      clearTimeout(this._ringStopTimeout);
      this._ringStopTimeout = null;
    }
    if (this._ytPlayer) {
      try {
        this._ytPlayer.stopVideo();
      } catch (_) {}
    }
    this._ytPrepared = false;
    this._stopSound();
    this._stopAlerts();
    this._ringing = false;
    this._paused = true;
    this._unbindBeforeUnload();
    this._releaseWakeLock();
    this._setRingingUI(false);
  }

  // === 操作系 ===
  snooze(min = 5) {
    const n = Number(min);
    const addMs = (Number.isFinite(n) && n > 0 ? n : 5) * 60000;

    // 鳴動中の音・アラートは止める
    this._stopSound();
    this._stopAlerts();
    this._ringing = false;

    // いまから +addMs で再スタート
    this._paused = false;
    this._endsAtMs = Date.now() + addMs;
    this._clear();
    this._tick();
    this._timer = setInterval(() => this._tick(), 200);
    this._bindBeforeUnload();
    this._requestWakeLock();

    // UI を通常モードへ戻す
    this._setRingingUI(false);
  }

  disconnect() {
    this._clear();
    this._unbindBeforeUnload();
    window.removeEventListener("keydown", this._onKeydown, { capture: true });
    document.removeEventListener("visibilitychange", this._reacquireWakeLock);
    this._releaseWakeLock();
    this._stopAlerts();
    this._stopSound();
  }

  // === 操作系 ===
  async start() {
    if (!this._paused || this._remainingMs <= 0) return;
    this._paused = false;
    this._endsAtMs = Date.now() + this._remainingMs;

    this._clear();
    this._tick();
    this._timer = setInterval(() => this._tick(), 200);

    // クリック直後＝ユーザー操作中に要求
    await this._unlockAudio(); // ← 自動再生対策（下に定義）
    this._bindBeforeUnload();
    await this._requestWakeLock();
    this._setRingingUI(false);

    const url = (this.musicUrlValue || "").trim();
    if (this._isYoutubeUrl(url)) {
      await this._prepareYouTube(url);
    }
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
    this._clear();
    this._stopSound();
    this._unbindBeforeUnload();
    await this._releaseWakeLock();
    this._stopAlerts();
    this._setRingingUI(false);

    // ★ 初期値へ
    this._remainingMs = this._initialMs;
    this._render(this._remainingMs);
  }

  // 現状使ってはいないが、将来的に復活予定
  // async stop() {
  //   // 鳴ってるのを完全停止
  //   this._paused = true;
  //   this._clear();
  //   this._stopSound();
  //   this._stopAlerts();
  //   await this._releaseWakeLock();

  //   // ★ 秒数を初期値に戻す
  //   this._remainingMs = this._initialMs;
  //   this._render(this._remainingMs);
  // }

  async testSound() {
    try {
      await this._ensureAudioUnlocked();
      await this._playSoundOnce();
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

  // === 内部処理 ===
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

  async _ring() {
    try {
      await this._ensureAudioUnlocked();
      const url = (this.musicUrlValue || "").trim();
      const isYT = this._isYoutubeUrl(url);

      let started = false;
      if (!url) {
        // 音源なし → ビープを“30秒”ループ
        await this._beepLoopFor(this._ringDurationMsForNonYouTube());
        started = true; // 自前で鳴らしている
        this._scheduleStopAfter(this._ringDurationMsForNonYouTube());
      } else if (isYT) {
        // YouTubeは“1曲”再生（失敗時はビープ30秒）
        const started = this._ytPrepared;
        started = this._ytPrepared
          ? await this._unmutePreparedYouTube()
          : await this._playYouTube(url);
        if (!started) {
          await this._beepLoopFor(this._ringDurationMsForNonYouTube());
          this._scheduleStopAfter(this._ringDurationMsForNonYouTube());
        } else {
          // セーフティ上限（例：15分）で自動停止
          this._scheduleStopAfter(15 * 60 * 1000);
        }
      } else {
        // asset/mp3 は30秒だけ鳴らす
        this.audioTarget.loop = true;
        this.audioTarget.src = url;
        this.audioTarget.volume = this._volume ?? 1;
        await this.audioTarget.play();
        started = true;
        this._scheduleStopAfter(this._ringDurationMsForNonYouTube());
      }

      if (started) {
        await this._notifyComplete(); // 通知・バイブ・タイトル点滅
        this._ringing = true;
        this._setRingingUI(true);
      }
    } catch (e) {
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

  _stopSound() {
    try {
      this.audioTarget.pause();
      this.audioTarget.currentTime = 0;
    } catch (_) {}
    if (this._osc) {
      try {
        this._osc.stop();
      } catch (_) {}
      try {
        this._osc.disconnect();
      } catch (_) {}
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

  async _ensureAudioUnlocked() {
    // クリック経由の呼び出しがあれば大抵OK
    return Promise.resolve();
  }

  async _playSoundOnce() {
    if (this.hasMusicUrlValue && this.musicUrlValue.trim() !== "") {
      this._stopSound();
      this.audioTarget.volume = this._volume ?? 1;
      await this.audioTarget.play();
    } else {
      await this._beepOnce();
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
    } catch (_) {}
    try {
      osc.disconnect();
    } catch (_) {}
    try {
      gain.disconnect();
    } catch (_) {}
    await ctx.close();
    this._osc = null;
    this._ctx = null;
  }

  async _beepPattern() {
    for (let i = 0; i < 6; i++) {
      await this._beepOnce(250, 1000);
      await new Promise((res) => setTimeout(res, 120));
    }
  }

  // === Wake Lock ===
  async _requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        if (this._wakeLock) {
          try {
            await this._wakeLock.release();
          } catch (_) {}
          this._wakeLock = null;
        }
        this._wakeLock = await navigator.wakeLock.request("screen");
        this._wakeLock.addEventListener("release", () => {
          // 必要なら UI 通知
        });
      }
    } catch (e) {
      console.warn("Wake Lock 拒否/失敗:", e);
    }
  }

  async _releaseWakeLock() {
    try {
      await this._wakeLock?.release();
    } catch (_) {}
    this._wakeLock = null;
  }

  // === 通知・バイブ・タイトル点滅 ===
  async _notifyComplete() {
    // 通知
    try {
      if ("Notification" in window) {
        if (Notification.permission === "default") {
          try {
            await Notification.requestPermission();
          } catch (_) {}
        }
        if (
          Notification.permission === "granted" &&
          document.visibilityState === "hidden"
        ) {
          new Notification("⏰ アラーム", { body: "時間だよ", silent: false });
        }
      }
    } catch (_) {}

    // バイブ
    try {
      navigator.vibrate?.([400, 120, 400, 120, 400]);
    } catch (_) {}

    // タイトル点滅
    if (!this._origTitle) this._origTitle = document.title;
    this._stopAlerts(); // 既存を止める
    this._titleBlinker = setInterval(() => {
      document.title = document.title.startsWith("⏰")
        ? this._origTitle
        : "⏰ 時間だよ";
    }, 900);

    // フォーカス戻ったら自動停止（1回だけ）
    const stopOnFocus = () => {
      this._stopAlerts();
    };
    window.addEventListener("focus", stopOnFocus, { once: true });
  }

  _stopAlerts() {
    if (this._titleBlinker) {
      clearInterval(this._titleBlinker);
      this._titleBlinker = null;
    }
    if (this._origTitle) document.title = this._origTitle;
  }

  // 追加：ユーザー操作中に許可を取る
  async _unlockAudio() {
    try {
      this._ctx =
        this._ctx || new (window.AudioContext || window.webkitAudioContext)();
      await this._ctx.resume();
    } catch (_) {}
    if (this.hasMusicUrlValue && this.musicUrlValue.trim() !== "") {
      try {
        const a = this.audioTarget;
        a.muted = true;
        a.volume = this._volume ?? a.volume;
        await a.play(); // 許可だけ取る
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      } catch (_) {}
    }
  }

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
      if (x.hostname === "youtu.be") return x.pathname.slice(1);
      if (x.searchParams.get("v")) return x.searchParams.get("v");
      const m = x.pathname.match(/\/embed\/([^/?#]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  async _ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) return;
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.onerror = () => rej(new Error("yt api load fail"));
      document.head.appendChild(s);
      window.onYouTubeIframeAPIReady = () => res();
      setTimeout(() => res(), 3000); // 3秒で諦め
    });
  }

  async _playYouTube(rawUrl) {
    try {
      await this._ensureYouTubeAPI();
      const vid = this._extractYouTubeId(rawUrl);
      if (!vid) return false;

      if (!this._ytPlayer) {
        this._ytPlayer = new YT.Player(
          this.hasYtPlayerTarget ? this.ytPlayerTarget : "yt-player",
          {
            height: "0",
            width: "0",
            videoId: vid,
            playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1 },
            events: {
              onStateChange: (e) => {
                if (e.data === YT.PlayerState.ENDED) this.stop(); // 1曲終了で停止
              },
            },
          }
        );
        // 初期化待ち（最大2秒）
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
          this._ytPlayer.loadVideoById(vid);
        } catch {
          return false;
        }
      }

      // 再生開始検知（最大2秒）
      const started = await new Promise((res) => {
        let seen = false,
          t0 = performance.now();
        const tick = () => {
          try {
            const st = this._ytPlayer.getPlayerState();
            if (st === YT.PlayerState.PLAYING) seen = true;
          } catch {}
          if (seen) return res(true);
          if (performance.now() - t0 > 2000) return res(false);
          requestAnimationFrame(tick);
        };
        tick();
      });

      return started;
    } catch {
      return false;
    }
  }

  // ビープを一定時間ループ（YouTube失敗や音源なし用）
  async _beepLoopFor(totalMs) {
    const end = Date.now() + totalMs;
    while (Date.now() < end) {
      await this._beepOnce(250, 1000);
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}
