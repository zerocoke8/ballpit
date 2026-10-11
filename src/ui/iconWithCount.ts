// 아이콘 + 숫자 (코인 수, 하트 수 등). 원점은 좌상단, 아이콘은 size × size.
import { Container, Sprite, Text } from 'pixi.js';
import { killTweensOf, tween } from '../core/tween';
import { tex } from '../render/assets';
import { textStyle } from './text';

export type IconWithCount = Container & { setCount(n: number): void };

export function iconWithCount(key: string, size: number): IconWithCount {
  const c = new Container() as IconWithCount;
  const icon = new Sprite(tex(key));
  icon.anchor.set(0.5);
  const baseScale = size / Math.max(1, icon.texture.width, icon.texture.height);
  icon.scale.set(baseScale);
  icon.position.set(size / 2, size / 2);

  const label = new Text({ text: '0', style: textStyle('number', { fontSize: Math.round(size * 0.72) }) });
  label.anchor.set(0, 0.5);
  label.position.set(size + Math.max(6, size * 0.15), size / 2);
  c.addChild(icon, label);

  let current = 0;
  c.setCount = (n: number) => {
    const text = String(n);
    if (label.text === text) return;
    const grew = n > current;
    current = n;
    label.text = text;
    if (grew) {
      killTweensOf(icon.scale);
      icon.scale.set(baseScale * 1.25);
      tween(icon.scale, { x: baseScale, y: baseScale }, 0.25, 'outBack');
    }
  };
  return c;
}
