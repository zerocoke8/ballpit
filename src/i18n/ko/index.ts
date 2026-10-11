import { bag } from './bag';
import { combat } from './combat';
import { common } from './common';
import { menu } from './menu';
import { shop } from './shop';

export const T = { menu, combat, bag, shop, common } as const;
export { menu, combat, bag, shop, common };
