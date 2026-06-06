import {
  Box,
  Plug,
  Disc3,
  Wrench,
  Flag,
  Package,
  type LucideIcon,
} from 'lucide-react';
import type { ItemKind } from '@/lib/inventory-shape';

// Map an inventory item KIND -> a lucide icon for the manifest table. This replaces the old
// custom Icon/kindIcon path (which returned bespoke glyph names tied to a deleted primitive).
// lucide-react is the only icon source per DESIGN_SYSTEM.md §3. Unknown kinds fall back to Box.
const KIND_ICONS: Record<ItemKind, LucideIcon> = {
  equipment: Box,
  peripheral: Plug,
  consumable: Disc3,
  tool: Wrench,
  banner: Flag,
  fixture: Package,
  system: Box,
};

export function kindLucide(kind: string | undefined | null): LucideIcon {
  return (kind && KIND_ICONS[kind as ItemKind]) || Box;
}
