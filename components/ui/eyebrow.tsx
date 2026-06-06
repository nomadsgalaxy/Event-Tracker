import * as React from 'react';

import { cn } from '@/lib/utils';

// Eyebrow — the tiny uppercase muted label that sits above every block / header / card / column
// header row (DESIGN_ALIGNMENT.md §5: "Eyebrows everywhere ... the connective tissue"). Pure RSC,
// no state. Renders a <p> by default; pass `asChild` to project the styles onto a different element
// (e.g. a <span> inside a flex row, or an <h2> for a sectioning role) without an extra wrapper.
//
// Style is the canonical eyebrow recipe used across the existing app:
//   text-xs · tracking-wide · uppercase · text-muted-foreground · font-medium.

export interface EyebrowProps extends React.ComponentProps<'p'> {
  /** Render the child element instead of a <p>, forwarding the eyebrow classes onto it. */
  asChild?: boolean;
}

export function Eyebrow({ className, asChild = false, children, ...props }: EyebrowProps) {
  const classes = cn(
    'text-xs font-medium uppercase tracking-wide text-muted-foreground',
    className
  );

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{ className?: string }>;
    return React.cloneElement(child, {
      className: cn(classes, child.props.className),
    });
  }

  return (
    <p data-slot="eyebrow" className={classes} {...props}>
      {children}
    </p>
  );
}

export default Eyebrow;
