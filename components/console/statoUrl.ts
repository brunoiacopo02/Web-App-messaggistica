'use client';

import { parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { VISTE } from '@/lib/console/viste';
import { LANCIO_FASI } from '@/lib/lancio-fase';

/** Stato della console nell'URL: vista, fase del lancio, "solo non lette", ricerca, chat aperta.
 *  Un link copiato riapre la stessa schermata. */
export const PARSER_CONSOLE = {
  vista: parseAsStringLiteral(VISTE).withDefault('non_lette'),
  fase: parseAsStringLiteral(LANCIO_FASI),
  solo: parseAsStringLiteral(['non_lette'] as const),
  q: parseAsString,
  chat: parseAsInteger,
};

export function useStatoConsole() {
  return useQueryStates(PARSER_CONSOLE);
}
