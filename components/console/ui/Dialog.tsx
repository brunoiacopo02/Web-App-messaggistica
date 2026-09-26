'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { contenitoreConsole } from './portale';

interface DialogProps {
  aperto: boolean;
  onCambia: (aperto: boolean) => void;
  titolo: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** Dialog centrale (Radix dialog) sui token: bordo `.line`, ombra `.shadow`, raggio 8 px; apertura
 *  solo con un fade di 120 ms, niente scala né spostamento. */
export function Dialog({ aperto, onCambia, titolo, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={aperto} onOpenChange={onCambia}>
      <RadixDialog.Portal container={contenitoreConsole()}>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className="dialog">
          <div className="dialog-hd">
            <RadixDialog.Title className="dialog-title">{titolo}</RadixDialog.Title>
            <RadixDialog.Close className="iconbtn" aria-label="Chiudi">
              <X size={16} strokeWidth={1.75} />
            </RadixDialog.Close>
          </div>
          <RadixDialog.Description className="sr-only">{titolo}</RadixDialog.Description>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-ft">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
