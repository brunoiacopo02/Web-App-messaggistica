'use client';

import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { contenitoreConsole } from './portale';

interface TooltipProps {
  contenuto: ReactNode;
  children: ReactNode;
  lato?: 'top' | 'right' | 'bottom' | 'left';
}

/** Tooltip (Radix tooltip) sui token: bordo `.line`, ombra `.shadow`, raggio 8 px. Autosufficiente:
 *  incapsula il proprio `Provider`, quindi si usa senza cablaggio nel layout. */
export function Tooltip({ contenuto, children, lato = 'top' }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal container={contenitoreConsole()}>
          <RadixTooltip.Content className="tooltip" side={lato} sideOffset={6}>
            {contenuto}
            <RadixTooltip.Arrow className="tooltip-arrow" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
