// Divide la risposta di Mario in più messaggi separati (come farebbe un umano su
// WhatsApp): ogni a-capo diventa un messaggio a sé. Modulo client-safe (no import
// server), usato sia dal simulatore sia dal webhook. Niente righe vuote nelle bolle.
export function splitMarioMessages(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
