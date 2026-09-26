import { Phone } from 'lucide-react';
import { tintaAvatar, iniziali } from '@/lib/console/avatar';

interface AvatarProps {
  nome: string | null;
  telefono?: string | null;
  /** 36 px (`.av.lg`), per l'intestazione del thread. */
  grande?: boolean;
}

/** Iniziali su tinta stabile (`a1`…`a6`); senza nome mostra l'icona telefono. Decorativo: il nome
 *  compare comunque come testo accanto (riga lista, intestazione thread). */
export function Avatar({ nome, telefono, grande = false }: AvatarProps) {
  const chiave = nome || telefono || '';
  const testo = iniziali(nome);
  return (
    <span className={`av${grande ? ' lg' : ''} a${tintaAvatar(chiave)}`} aria-hidden="true">
      {testo || <Phone size={16} strokeWidth={1.75} />}
    </span>
  );
}
