'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { contenitoreConsole } from './portale';

/** Menu a comparsa (Radix dropdown-menu) sui token: bordo `.line`, ombra `.shadow`, raggio 8 px,
 *  apertura senza animazione. */
export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

interface MenuContentProps {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
}

export function MenuContent({ children, align = 'end' }: MenuContentProps) {
  return (
    <DropdownMenu.Portal container={contenitoreConsole()}>
      <DropdownMenu.Content className="menu" align={align} sideOffset={6}>
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

interface MenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  pericolo?: boolean;
  disabilitato?: boolean;
}

export function MenuItem({ children, onSelect, pericolo, disabilitato }: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={['menu-item', pericolo ? 'danger' : ''].filter(Boolean).join(' ')}
      disabled={disabilitato}
      onSelect={() => onSelect?.()}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="menu-sep" />;
}
