// The only interface: a small card of key hints and a line of status text.
// Both are hidden unless asked for, so a screen recording stays clean.

export interface HintState {
  palette: string;
  view: string;
  source: string;
  tracking: string;
  dust: string;
  stage: string;
  reel: boolean;
  wide: boolean;
  recording: boolean;
}

/** One hint: the key, what it does, and optionally the current value shown in bold. */
type Row = [key: string, describe: (s: HintState) => [text: string, value?: string]];

const rows: Row[] = [
  ['R', (s) => (s.recording ? ['Recording, press to', 'stop'] : ['Record a clip'])],
  ['T', (s) => ['Tracking', s.tracking]],
  ['[ ]', (s) => ['Dust', s.dust]],
  ['P', (s) => ['Palette', s.palette]],
  ['A', (s) => ['Stage', s.stage]],
  ['V', (s) => ['View', s.view]],
  ['M', (s) => (s.wide ? ['Record as a reel frame', s.reel ? 'on' : 'off'] : ['Reel frame (wide stages only)'])],
  ['C', () => ['Move the picture']],
  ['Space', () => ['Scatter everything']],
  ['D', (s) => ['Source', s.source]],
  ['F', () => ['Full screen']],
  ['H', () => ['Hide these hints']],
];

export class Overlay {
  private readonly hints = document.getElementById('hints') as HTMLElement;
  private readonly notice = document.getElementById('notice') as HTMLElement;
  private readonly rec = document.getElementById('rec') as HTMLElement;
  private timer = 0;

  /** Show or hide the recording light, with the running time beside it. */
  recording(seconds: number | null): void {
    this.rec.hidden = seconds === null;
    if (seconds === null) return;
    const whole = Math.floor(seconds);
    const text = `REC ${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
    const label = this.rec.lastElementChild as HTMLElement;
    if (label.textContent !== text) label.textContent = text;
  }

  toggle(): void {
    this.hints.hidden = !this.hints.hidden;
  }

  /** Rebuild the hint card. Built from nodes and plain text, never from markup. */
  describe(state: HintState): void {
    const title = document.createElement('h1');
    title.textContent = 'Dust';
    const list = document.createElement('dl');
    for (const [key, describe] of rows) {
      const [text, value] = describe(state);
      const term = document.createElement('dt');
      term.textContent = key;
      const detail = document.createElement('dd');
      detail.textContent = value === undefined ? text : `${text} `;
      if (value !== undefined) {
        const strong = document.createElement('b');
        strong.textContent = value;
        detail.append(strong);
      }
      list.append(term, detail);
    }
    this.hints.replaceChildren(title, list);
  }

  /** Show a line of text for a few seconds. */
  say(text: string, seconds = 3.5): void {
    this.notice.textContent = text;
    this.notice.classList.add('on');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.notice.classList.remove('on'), seconds * 1000);
  }
}
