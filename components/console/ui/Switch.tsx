'use client';

import * as RadixSwitch from '@radix-ui/react-switch';

interface SwitchProps {
  id?: string;
  acceso: boolean;
  onCambia: (acceso: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/** Interruttore della console (Radix switch) sui token: binario `.sw`, pallino che scorre in 160 ms. */
export function Switch({ id, acceso, onCambia, disabled, ...aria }: SwitchProps) {
  return (
    <RadixSwitch.Root id={id} className="sw" checked={acceso} onCheckedChange={onCambia} disabled={disabled} {...aria}>
      <RadixSwitch.Thumb className="sw-t" />
    </RadixSwitch.Root>
  );
}
