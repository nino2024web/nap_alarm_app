import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = ["input"];

  async test() {
    const url = (this.inputTarget.value || "").trim();
    if (!url) {
      // URLない時はビープで確認
      await this._beepOnce();
      return;
    }
    try {
      const a = new Audio(url);
      a.crossOrigin = "anonymous";
      await a.play();
    } catch (e) {
      alert("再生がブロック/失敗。直リンクか別ブラウザで試して。");
      console.warn(e);
    }
  }

  async _beepOnce(duration = 500, freq = 880) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    await new Promise((r) => setTimeout(r, duration));
    try {
      osc.stop();
      osc.disconnect();
      gain.disconnect();
    } catch {}
    await ctx.close();
  }
}
