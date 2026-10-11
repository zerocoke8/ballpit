// 키 입력 상태. KeyboardEvent.code 기준 (예: 'ArrowLeft', 'KeyA', 'Space', 'Escape').

const PREVENT_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class Keyboard {
  private readonly down = new Set<string>();
  private readonly handlers = new Map<string, Set<() => void>>();
  private disposed = false;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** 키를 처음 누를 때마다(자동 반복 제외) 호출. 해제 함수 반환 */
  onPress(code: string, cb: () => void): () => void {
    let set = this.handlers.get(code);
    if (!set) {
      set = new Set();
      this.handlers.set(code, set);
    }
    set.add(cb);
    return () => {
      this.handlers.get(code)?.delete(cb);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.down.clear();
    this.handlers.clear();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
    this.down.add(e.code);
    if (e.repeat) return;
    const set = this.handlers.get(e.code);
    if (!set) return;
    for (const cb of [...set]) cb();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.down.clear();
  };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}
