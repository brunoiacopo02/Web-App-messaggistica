/**
 * La presa del recap GDO: chi la vince lo manda, gli altri no. È un update
 * condizionale sulla riga della conversazione, così due drain (o il drain e un
 * webhook) non mandano lo stesso riassunto due volte per la stessa call.
 */

type Supa = {
  from: (t: string) => any;
};

/**
 * Segna il recap per la call di `appuntamentoAt` solo se per quella stessa call non è
 * già uscito. Con `conNoemi` segna anche il promemoria di Noemi, se mancava: il recap
 * la nomina, e il bot non deve rispiegarla al turno dopo. Torna `true` se ha preso il
 * recap (una riga aggiornata).
 */
export async function claimRecap(
  supabase: Supa,
  conversationId: number,
  appuntamentoAt: string,
  conNoemi: boolean,
): Promise<boolean> {
  // L'istante arriva in fusi diversi (CRM con +02:00, colonna in UTC): nel filtro
  // dell'URL il confronto deve avvenire sulla stessa scrittura.
  const at = new Date(appuntamentoAt).toISOString();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('conversations')
    .update({ gdo_recap_for_at: at, gdo_recap_sent_at: now })
    .eq('id', conversationId)
    .or(`gdo_recap_for_at.is.null,gdo_recap_for_at.neq.${at}`)
    .select('id');
  if (error) {
    console.error(`[gdo] claim del recap fallito su conv ${conversationId}: ${error.message}`);
    return false;
  }
  if (!data || data.length === 0) return false;
  if (conNoemi) {
    await supabase
      .from('conversations')
      .update({ gdo_noemi_reminded_at: now })
      .eq('id', conversationId)
      .is('gdo_noemi_reminded_at', null);
  }
  return true;
}
