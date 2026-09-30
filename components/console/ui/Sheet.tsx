'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { contenitoreConsole } from './portale';

interface SheetProps {
  aperto: boolean;
  onCambia: (aperto: boolean) => void;
  titolo: string;
  children: ReactNode;
  /** Mentre è vero il pannello non si chiude: niente X, Esc e clic fuori vengono ignorati. */
  bloccato?: boolean;
}

/** Pannello laterale (Radix dialog, ancorato a destra) sui token: bordo `.line`, ombra `.shadow`;
 *  apertura solo con un fade di 120 ms, niente scivolamento. */
export function Sheet({ aperto, onCambia, titolo, children, bloccato = false }: SheetProps) {
  return (
    <RadixDialog.Root open={aperto} onOpenChange={(v) => { if (v || !bloccato) onCambia(v); }}>
      <RadixDialog.Portal container={contenitoreConsole()}>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className="sheet">
          <div className="sheet-hd">
            <RadixDialog.Title className="dialog-title">{titolo}</RadixDialog.Title>
            <RadixDialog.Close className="iconbtn" aria-label="Chiudi" disabled={bloccato}>
              <X size={16} strokeWidth={1.75} />
            </RadixDialog.Close>
          </div>
          <RadixDialog.Description className="sr-only">{titolo}</RadixDialog.Description>
          <div className="sheet-body">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
