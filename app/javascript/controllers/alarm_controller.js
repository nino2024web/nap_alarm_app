import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static values = { endsAt: Number, duration: Number, musicUrl: String };
  static targets = ["display", "audio"];

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
    if (this.hasMusicUrlValue && this.musicUrlValue.trim() !== "") {
      this.audioTarget.src = this.musicUrlValue;
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

      // Space
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault(); // スクロール抑止
        if (this._ringing) {
          // 鳴動中は「音停止」だけ
          this._stopSound();
          this._stopAlerts();
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
        this._stopSound();
        this._stopAlerts();
      }
    };
    window.addEventListener("keydown", this._onKeydown, { capture: true });

    document.addEventListener("visibilitychange", this._reacquireWakeLock);

    if (this._initialMs > 0) {
      this.start();
    }
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
      if (!this.hasMusicUrlValue || this.musicUrlValue.trim() === "") {
        await this._beepPattern();
      } else {
        this.audioTarget.volume = this._volume ?? 1;
        await this.audioTarget.play();
      }
      await this._notifyComplete(); // 通知・バイブ・タイトル点滅
      this._ringing = true;
    } catch (e) {
      this.displayTarget.textContent = "再生ボタン押して！";
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
}
