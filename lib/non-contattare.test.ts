import { describe, expect, it } from 'vitest';
import { chiedeDiNonEssereContattato } from './non-contattare';

describe('chiedeDiNonEssereContattato (PO 12/11/2026)', () => {
  it.each([
    // chat 32198, col refuso com'è arrivato
    'Allora oggi non posso dato che insistete non voglio più essere contatta',
    'non voglio più essere contattata',
    'Non voglio essere più chiamato',
    'non desidero essere contattato più',
    'Non contattatemi più',
    'non mi chiamate più',
    'NON CHIAMATEMI MAI PIÙ',
    'per favore non mi cercate più',
    'non mi dovete più chiamare',
    'al momento non sono più interessata, non contattarmi più',
    'non voglio più ricevere chiamate',
    'Cancella pure il mio contatto.',
    'cancellate il mio numero grazie',
    'toglietemi dalla lista',
    'vi chiedo di eliminare i miei dati',
  ])('sì: «%s»', (t) => expect(chiedeDiNonEssereContattato(t)).toBe(true));

  it.each([
    // il formato della call, non un addio (manuale: NON È UNA RICHIESTA DI PASSAGGIO)
    'non voglio essere chiamato',
    'Posso chiedere di non ricevere la chiamata ?',
    'non rispondo alle telefonate',
    // solo i messaggi del bot: decide il giudice leggendo la chat
    'ho già un appuntamento con Noemi domani, non rispondermi più',
    'non scrivermi più',
    // «più» che non c'entra col contatto
    'non mi chiamate più tardi delle 18',
    'non voglio essere chiamata più tardi',
    'non cerco più lavoro',
    'non mi sento più sicura',
    'non sono più interessato',
    'non posso più partecipare',
    // disdette e spostamenti normali
    'annullate la chiamata',
    'oggi non posso, possiamo fare domani?',
    'vi ricontatto io',
    'cancellate la call di domani',
    'cancella l\'appuntamento',
    '',
  ])('no: «%s»', (t) => expect(chiedeDiNonEssereContattato(t)).toBe(false));

  it('più messaggi dello stesso turno uniti', () => {
    expect(chiedeDiNonEssereContattato(['Cancello la chiamata', 'In questo momento non ho tempo', 'Non contattatemi più'].join(' / '))).toBe(true);
    expect(chiedeDiNonEssereContattato(null)).toBe(false);
  });
});

/**
 * I 41 messaggi veri che hanno chiesto di non essere più contattati (chat del bot, agosto-
 * novembre 2026; la mail di una lead è oscurata). Devono continuare a far scattare lo stop
 * anche dopo la stretta sui «toglietemi/cancellatemi» da soli (revisione 13/11/2026).
 */
const STOP_REALI: [number, string][] = [
  [4333, "vi scrivo per disdire la chiamata fissata per domani. Ho valutato la proposta e al momento non sono interessato/a al corso. Vi chiedo gentilmente di cancellare i miei recapiti dai vostri archivi e di non ricontattarmi in futuro. Grazie e buon lavoro.\""],
  [4339, "Buonasera, ho parlato con mio marito, non ho visto il video ma non sono più interessata. GRAZIE Siete pregati di non contattarmi più 🙏"],
  [4488, "Anche perché ho chiamato alla Fenice Academy e voi non risultate come nomi e poi questa insistenza che avete con i clienti mi ha fatto sorgere dubbi. I piani di costo sono anche diversi quindi non mi chiamate più evitiamo tutto"],
  [4788, "Ciao, ho capito cosa hai detto. Aiuti solo chi studia con te. Quindi ti ho detto che non voglio studiare, voglio solo lavorare. Perciò hai scritto che non puoi aiutarmi in questo. Allora la questione è chiusa. Se si tratta di questioni lavorative, puoi aiutarmi. Altrimenti, per favore, non contattarmi più in futuro. Grazie."],
  [5399, "Ha sbagliato nr e perosna. Cortesemente non contattatemi più."],
  [7105, "Guardi non mi chiami più e togliete i miei rif. Dai vostri registri"],
  [7481, "Buongiorno, Non desidero più essere contattato, grazie."],
  [8828, "Ok guarda non chiamate più allora"],
  [9604, "Entrambe le cose, non è iniziare con un piede giusto la mancanza di trasparenza, vi chiederei di cancellare i miei dati, grazie"],
  [8407, "Ciao, non mi interessa piu per favore non mi contattate piu"],
  [9760, "Per cortesia, chiedo la vostra comprensione e disponibilità nel non contattarmi più, sino a quando non decido io stessa di prendere contatto con voi, come già esplicitamente comunicato, Grazie"],
  [11618, "...Ciao, ho valutato la proposta e ho deciso di declinare l'offerta e di cancellare la mia partecipazione alla chiamata di martedì... Vi chiedo gentilmente di non considerarmi per il percorso e di rimuovere i miei dati dai vostri elenchi... Buon lavoro..."],
  [13951, "Non contattatemi più grazie"],
  [13422, "salve le rispondo così perché si vede che in chiamata non avete capito, ho già spiegato ai suoi colleghi nelle varie chiamate che mi sono arrivate che io devo finire la 5 e non sono interessata mi ero informata solo per sapere com’era quindi la prego lei e i suoi colleghi di segnarvi che io non voglio più essere contattata, grazie"],
  [14308, "no,non mi chiamate più"],
  [18342, "Ciao preferisco che eliminiate i miei dati"],
  [18737, "Eliminate ogni mio contatto dalla vostra academy, non voglio più essere contattato per nessuna ragione"],
  [18742, "Non sono Aurora. cancelli il mio numero, grazie"],
  [20330, "Vi chiedo la cancellazione dei miei dati dal vostro database in quanto davo per scontato corsi fossero gratuiti come da vostra pubblicità su Instagram. Sono stato contattato in chat e ho risposto che avrei eventualmente dato una risposta la prossima settimana, nonostante la mia risposta, mi avete chiamato pressandomi e affermando che le mie fossero scuse per non partecipare quando mi avete fissato con fretta appuntamento per mercoledì, anziché rispettare il mio no peraltro per motivi personali gravi. Vi invito a non contattarmi più, non sono interessato a corsi a pagamento in qualsiasi soluzione."],
  [23314, "Buonasera, non desidero più essere contattata. Grazie, buon lavoro"],
  [16358, "Siete dei ladri. Cancellate il mio numero dai vostri contatti Questo corsi esistono anche promossi dalle regioni a costo zero con tanto di stage in azienda."],
  [23985, "Non chiamatemi più ok"],
  [16701, "Non voglio partecipare a nulla. Non contattatemi più"],
  [17193, "Toglietemi tranquillamente dai contatti ai quali mandate i messaggi, nel caso in futuro riscrivo io"],
  [19825, "Ciao, ti ringrazio molto per il pensiero e per l'opportunità ma al momento il percorso Web Developer AI non rientra tra i miei interessi e priorità. Ti chiedo la cortesia di non aggiornarmi ulteriormente su questo percorso e di eliminare il mio contatto dai prossimi invii relativi alla promozione. Grazie per la comprensione e buon proseguimento, Elisabetta"],
  [20404, "Cancella i miei dati, grazie"],
  [22833, "1. il video è di un commerciale standard ne esistono milioni e tutti uguali 2. Si pubblicizza una proposta lavorativa e si cerca di vendere un corso con eventualmente dei colloqui 3. Quando si da un appuntamento non si arriva ne prima ne dopo ma allorario stabilito. Sono solo 3 delle motivazioni che mi portano a credere non essere un qualcosa per me. Di nuovo buon pomeriggio, ti e vi chiedo anche di eliminare i miei contatti non voglio ricevere altre chiamate o pubblicità."],
  [26273, "Sto bene ma era curiosità mi ha portato avvicinare, se non va bene per voi togliete dalla lista"],
  [17471, "Buongiorno! Mi sono disiscritta dalle newsletter ma continuo a riceverle. Potresti gentilmente controllare ed eliminare i miei dati per favore? La mail con cui mi ero iscritta è <email> Grazie mille! ☺️"],
  [20359, "Buonasera, mi dispiace ma non avevo modo di rispondere. Ho riflettuto sulla questione e al momento non sono più interessata all’offerta di Fenice Academy, quindi vi chiedo gentilmente di non contattarmi più. Se in futuro dovessi cambiare idea, vedrò di compilare il modulo per richiedere informazioni. Intanto vi ringrazio per la disponibilità e vi auguro una buona serata."],
  [27286, "Ok grazie non posso comprare niente. Ti saluto e cancella i miei dati"],
  [29296, "Grazie a voi preferirei visto che non potrò farlo che cancellereste i miei dati grazie"],
  [29623, "Non contattatemi più"],
  [30318, "Caspita gli impegni si possono anche disdire ! Questo modo di lavorare volto a fare sentire in colpa un potenziale cliente nono garba proprio!! Cancella pure il mio contatto."],
  [31271, "non mi contattate più grazie mille non serve che farò perdere solo tempo a voi"],
  [31208, "nono grazie rifiuto l’offerta, non contattatemi più"],
  [3301, "Ho visto il video. Non chiamatemi più. Vi ringrazio. Troppo costoso Grz amcora"],
  [31533, "Questa è la seconda volta che mi contattare telefonicamente nonostante avessi detto chiaramente che volessi aspettare a Gennaio per essere contattata . Quindi non voglio essere contattata ulteriormente ne ora e ne mai più Non voglio essere più contattata"],
  [32198, "Allora oggi non posso dato che insistete non voglio più essere contatta"],
  [33222, "Nella pubblicità diceva che i corsi erano gratuiti...mi sembra assurdo pagare per poter lavorare...se la questione è così *Cancellate* il mio contatto *ora* grazie"],
  [33222, "Ho già detto *CANCELLATE IL MIO CONTATTO*"],
];

describe('i 41 stop veri continuano a scattare', () => {
  it.each(STOP_REALI)('chat %i', (_conv, t) => expect(chiedeDiNonEssereContattato(t)).toBe(true));
});

describe('«toglietemi / cancellatemi / eliminatemi / rimuovetemi» da soli non bastano (revisione 13/11/2026)', () => {
  it.each([
    // chat 27983: vuole la chiamata, non l'addio
    'Non mi avete chiamato e sta arrivando la cliente. Il mio tempo non e vostro vi sto dando la mia disponibilità. Chiamatemi o toglietemi del promemoria. Grazie',
    'Chiamatemi o toglietemi del promemoria',
    'toglietemi',
    'cancellatemi',
    'eliminatemi pure',
    'rimuovetemi',
    'cancellatemi la call di domani',
    'toglietemi questo dubbio: quanto costa?',
  ])('no: «%s»', (t) => expect(chiedeDiNonEssereContattato(t)).toBe(false));

  it.each([
    // con l'oggetto: la lista, i contatti, il numero, i dati
    'Toglietemi tranquillamente dai contatti ai quali mandate i messaggi',
    'toglietemi dalla lista',
    'cancellatemi dalla vostra lista',
    'eliminatemi dai vostri contatti',
    'rimuovetemi dal vostro database',
    'cancellatemi dai vostri archivi grazie',
    'toglietemi il numero',
    'eliminatemi il contatto per favore',
  ])('sì: «%s»', (t) => expect(chiedeDiNonEssereContattato(t)).toBe(true));
});
