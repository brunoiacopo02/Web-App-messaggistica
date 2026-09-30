'use client';

import { useState } from 'react';
import { Lock, TriangleAlert } from 'lucide-react';
import type { LancioSettingKey, LancioSettings } from '@/lib/lancio-settings';
import type { ChiaveImpostazione, UltimoCambio } from '@/lib/console/impostazioni';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';

/**
 * Impostazioni della console: le stesse manopole di `/fenice/impostazioni` (lancio) e
 * l'auto-risposta di Mario di `/fenice/live`, con le stesse rotte e gli stessi payload.
 * Cambia solo la presentazione, più un gesto: ogni modifica mostra prima → dopo e chiede
 * conferma, perché quasi tutte spostano messaggi WhatsApp verso i lead.
 */

type Esito = { tono: 'ok' | 'avviso' | 'errore'; testo: string };
type Interruttore = 'fenice_ai_autoreply' | 'lancio_attivo' | 'lancio_pulsante_attivo';
type Conferma = { key: ChiaveImpostazione; dopo: string };

/** I motivi della rotta, gli stessi del pannello vecchio; il prefisso "Non salvato:" lo mette `esitoErrore`. */
const ERRORI: Record<string, string> = {
  link_non_https: 'serve un link completo che inizi con https://',
  data_non_valida: 'serve una data ISO con fuso, es. 2026-10-05T21:00:00+02:00',
  chiave_non_modificabile: 'questa impostazione non si cambia da qui.',
  valore_non_valido: 'valore non valido.',
  sola_lettura: 'il tuo account vede le impostazioni ma non le cambia.',
  scrittura_fallita: 'il database ha rifiutato la scrittura. Riprova, e se insiste cambiala in SQL.',
};

const INTERRUTTORI: Array<{ key: Interruttore; label: string; hint: string; acceso: string; spento: string }> = [
  {
    key: 'fenice_ai_autoreply',
    label: 'Mario risponde da solo',
    hint: "L'interruttore generale di Mario: spento, non risponde e non adotta le chat nuove. Si spegne durante un incidente.",
    acceso: 'Mario torna a rispondere su WhatsApp e ad adottare le chat nuove: sono messaggi che escono verso i lead.',
    spento: 'Mario smette di rispondere e non adotta più chat nuove, finché non lo riaccendi.',
  },
  {
    key: 'lancio_attivo',
    label: 'Lancio attivo',
    hint: 'Spento: benvenuti differiti, blast Zoom e follow-up non mandano nulla. Il freno automatico lo spegne da solo: riaccenderlo è un gesto umano. Le restituzioni al pool non dipendono da qui.',
    acceso: 'Da questo momento i benvenuti in coda, il blast dello Zoom e i follow-up ripartono davvero: sono messaggi WhatsApp che escono verso i lead.',
    spento: 'Il lancio smette di mandare messaggi. I lead non si perdono: restano in coda e ripartono quando lo riaccendi.',
  },
  {
    key: 'lancio_pulsante_attivo',
    label: 'Pulsante del webinar',
    hint: 'Acceso la sera della live: la frase del pulsante wa.me porta la chat nel dopo-pitch. Spento, è un messaggio come un altro.',
    acceso: 'Chi scrive la frase del pulsante finisce nel dopo-pitch. Acceso troppo presto, ci finisce anche chi la scrive per caso, e quel lead perde il blast dello Zoom.',
    spento: 'La frase del pulsante torna a valere come un messaggio qualunque: chi la scrive resta un inbound normale.',
  },
];

const CAMPI_SCELTA: Array<{ key: LancioSettingKey; label: string; hint: string; opzioni: Array<{ value: string; label: string }> }> = [
  {
    key: 'lancio_sender',
    label: 'Mittente del lancio',
    hint: 'Vale sui benvenuti: “secondario” li manda tutti dai numeri secondari e batte la quota qui sotto. Scavalca i tetti giornalieri, ma non i numeri a riposo (tetto 0): se nessun secondario è disponibile partono dal principale. Blast Zoom e follow-up non sanno ancora partire dal secondario: lasciano un avviso nei log e partono dal principale.',
    opzioni: [{ value: 'principale', label: 'Numero principale' }, { value: 'secondario', label: 'Numeri secondari' }],
  },
  {
    key: 'lancio_blast_perimetro',
    label: 'Perimetro del blast Zoom',
    hint: '“Tutti” manda il link a chiunque sia in attesa o con il posto bloccato; “risposto” solo a chi ha scritto almeno una volta (piano B).',
    opzioni: [{ value: 'tutti', label: 'Tutti' }, { value: 'risposto', label: 'Solo chi ha risposto' }],
  },
];

const CAMPI_TESTO: Array<{ key: LancioSettingKey; label: string; hint: string; placeholder: string }> = [
  {
    key: 'lancio_quota_secondario',
    label: 'Benvenuti verso i numeri secondari (%)',
    hint: 'Quota di riscaldamento verso i numeri secondari, solo sui benvenuti del lancio: 9 vuol dire uno da un secondario ogni dieci dal principale. La quota rispetta i tetti giornalieri dei numeri: un secondario pieno o a riposo (tetto 0) non viene usato, e quel benvenuto parte dal principale. 0 (o vuoto) = tutti dal numero storico. Lo stesso lead finisce sempre sullo stesso numero, e se il template non è spedibile da nessun secondario parte comunque dal principale.',
    placeholder: '0',
  },
  {
    key: 'lancio_evento_at',
    label: 'Inizio della live (ISO con fuso)',
    hint: 'Da qui derivano blast, finestre del follow-up e data delle restituzioni. Non si azzera.',
    placeholder: '2026-10-05T21:00:00+02:00',
  },
  {
    key: 'lancio_zoom_link',
    label: 'Link Zoom della live',
    hint: 'Lo manda il blast della sera dell’evento. Senza, il blast non parte.',
    placeholder: 'https://us06web.zoom.us/j/...',
  },
  {
    key: 'lancio_video_live_link',
    label: 'Video della live editata',
    hint: 'Lo manda Mario, al posto dei quattro video classici, a chi risponde al follow-up del giorno dopo. Vuoto = video classici.',
    placeholder: 'https://corso.feniceacademy.it/...',
  },
  {
    key: 'offerta_del_mese_link',
    label: 'Video offerta del mese',
    hint: 'Lo manda Marta quando il GDO sceglie “Offerta del mese” in agenda. Vuoto = nessun video (resta un avviso nei log).',
    placeholder: 'https://corso.feniceacademy.it/...',
  },
];

const ETICHETTA: Record<ChiaveImpostazione, string> = Object.fromEntries(
  [...INTERRUTTORI, ...CAMPI_SCELTA, ...CAMPI_TESTO].map((c) => [c.key, c.label]),
) as Record<ChiaveImpostazione, string>;

const INTERRUTTORE = new Set<string>(INTERRUTTORI.map((i) => i.key));

function valoriIniziali(s: LancioSettings, autoReply: boolean): Record<ChiaveImpostazione, string> {
  return {
    fenice_ai_autoreply: autoReply ? '1' : '0',
    lancio_attivo: s.attivo ? '1' : '0',
    lancio_pulsante_attivo: s.pulsanteAttivo ? '1' : '0',
    lancio_zoom_link: s.zoomLink ?? '',
    lancio_video_live_link: s.videoLiveLink ?? '',
    offerta_del_mese_link: s.offertaDelMeseLink ?? '',
    lancio_evento_at: s.eventoAt ?? '',
    lancio_blast_perimetro: s.blastPerimetro,
    lancio_sender: s.sender,
    lancio_quota_secondario: String(s.quotaSecondario),
  };
}

/** Il valore come lo legge una persona: interruttori, etichette delle opzioni, "(vuoto)". */
function leggibile(key: ChiaveImpostazione, v: string): string {
  if (INTERRUTTORE.has(key)) return v === '1' ? 'Acceso' : 'Spento';
  const scelta = CAMPI_SCELTA.find((c) => c.key === key);
  if (scelta) return scelta.opzioni.find((o) => o.value === v)?.label ?? v;
  return v === '' ? '(vuoto)' : v;
}

/** Il valore restituito dalla rotta, nella forma dello stato del pannello. */
function dalServer(v: unknown, inviato: string | boolean): string {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return v;
  return typeof inviato === 'boolean' ? (inviato ? '1' : '0') : inviato;
}

type Salvataggio = { ok: true; valore: string; audit: boolean } | { ok: false; motivo: string };

/** POST sulla rotta del lancio: stesso corpo `{ key, value }` del pannello vecchio. */
async function salvaLancio(key: LancioSettingKey, value: string | boolean): Promise<Salvataggio> {
  const res = await fetch('/api/fenice/lancio-settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; errore?: string; value?: unknown; audit?: boolean };
  if (!res.ok || !data.ok) {
    const codice = data.errore ?? data.error ?? '';
    return { ok: false, motivo: ERRORI[codice] ?? `il server ha risposto ${res.status}.` };
  }
  return { ok: true, valore: dalServer(data.value, value), audit: data.audit !== false };
}

/**
 * POST sulla rotta di Mario con `{ on }`, come `/fenice/live`. Quella rotta risponde 200 anche se
 * la scrittura non è andata (non legge l'errore del database): per non mostrare un "Salvato"
 * falso, il valore si rilegge con la GET della stessa rotta e deve coincidere.
 */
async function salvaAutoReply(on: boolean): Promise<Salvataggio> {
  const res = await fetch('/api/fenice/autoreply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
  if (!res.ok || !data.ok) return { ok: false, motivo: `il server ha risposto ${res.status}.` };
  const riletto = await fetch('/api/fenice/autoreply');
  const letto = (await riletto.json().catch(() => ({}))) as { on?: unknown };
  if (!riletto.ok || letto.on !== on) {
    return { ok: false, motivo: `rileggendo, Mario risulta ancora ${letto.on === true ? 'acceso' : letto.on === false ? 'spento' : 'in uno stato sconosciuto'}. Riprova.` };
  }
  return { ok: true, valore: on ? '1' : '0', audit: true };
}

export function Impostazioni({
  initial,
  autoReply,
  cambi,
  puoModificare,
}: {
  initial: LancioSettings;
  autoReply: boolean;
  cambi: Partial<Record<ChiaveImpostazione, UltimoCambio>>;
  puoModificare: boolean;
}) {
  /** L'ultimo valore che il server ha confermato: è il "prima" di ogni conferma. */
  const [salvati, setSalvati] = useState(() => valoriIniziali(initial, autoReply));
  /** I campi di testo mentre li scrivi. */
  const [bozze, setBozze] = useState(() => valoriIniziali(initial, autoReply));
  const [esiti, setEsiti] = useState<Partial<Record<ChiaveImpostazione, Esito>>>({});
  const [busy, setBusy] = useState<ChiaveImpostazione | null>(null);
  const [conferma, setConferma] = useState<Conferma | null>(null);

  function chiedi(key: ChiaveImpostazione, dopo: string) {
    setEsiti((s) => ({ ...s, [key]: undefined }));
    setConferma({ key, dopo });
  }

  async function confermato() {
    if (!conferma) return;
    const { key, dopo } = conferma;
    const prima = salvati[key];
    setConferma(null);
    setBusy(key);
    let esito: Salvataggio;
    try {
      if (key === 'fenice_ai_autoreply') esito = await salvaAutoReply(dopo === '1');
      else esito = await salvaLancio(key, INTERRUTTORE.has(key) ? dopo === '1' : dopo);
    } catch {
      esito = { ok: false, motivo: 'errore di rete. Il valore non è cambiato: riprova.' };
    } finally {
      setBusy(null);
    }
    if (!esito.ok) {
      setEsiti((s) => ({ ...s, [key]: { tono: 'errore', testo: `Non salvato: ${esito.motivo}` } }));
      return;
    }
    const valore = esito.valore;
    setSalvati((v) => ({ ...v, [key]: valore }));
    setBozze((v) => ({ ...v, [key]: valore }));
    const fatto = valore === '' ? 'Azzerato' : 'Salvato';
    const reale = `${leggibile(key, prima)} → ${leggibile(key, valore)}`;
    setEsiti((s) => ({
      ...s,
      [key]: esito.audit
        ? { tono: 'ok', testo: `${fatto}: ${reale}` }
        : { tono: 'avviso', testo: `${fatto}: ${reale}, ma senza traccia nel registro` },
    }));
  }

  /** La conferma in linea sotto la riga: prima → dopo, cosa succede ai lead, due bottoni. */
  function striscia(k: ChiaveImpostazione, testo: string | null, verbo: string) {
    if (conferma?.key !== k) return null;
    return (
      <div className="imp-conf" role="group" aria-label={`Conferma ${ETICHETTA[k]}`}>
        <p className="imp-conf-t">
          {INTERRUTTORE.has(k) ? `${conferma.dopo === '1' ? 'Accendere' : 'Spegnere'} “${ETICHETTA[k]}”?` : `Cambiare “${ETICHETTA[k]}”?`}
        </p>
        <p className="imp-conf-pd">
          <span className="mono">{leggibile(k, salvati[k])} → {leggibile(k, conferma.dopo)}</span>
        </p>
        {testo && <p className="imp-conf-m">{testo}</p>}
        <div className="imp-conf-act">
          <Button variante="primario" onClick={() => void confermato()}>{verbo}</Button>
          <Button variante="fantasma" onClick={() => setConferma(null)}>Annulla</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="imp">
      <header className="imp-hd">
        <h1>Impostazioni</h1>
        <p>Interruttori, link e mittente del lancio si cambiano da qui, senza deploy. Ogni modifica mostra il prima e il dopo e chiede conferma.</p>
      </header>

      {!puoModificare && (
        <p className="imp-ro">
          <Lock size={16} strokeWidth={1.75} className="ico" />
          Il tuo account vede le impostazioni ma non le cambia.
        </p>
      )}

      <section className="imp-sez" aria-labelledby="imp-int">
        <h2 id="imp-int">Interruttori</h2>
        {INTERRUTTORI.map(({ key, label, hint, acceso, spento }) => {
          const inAttesa = conferma?.key === key;
          const on = (inAttesa ? conferma.dopo : salvati[key]) === '1';
          return (
            <div key={key} className="imp-riga" role="group" aria-labelledby={`l-${key}`}>
              <div className="imp-tx">
                <label id={`l-${key}`} htmlFor={key} className="imp-l">{label}</label>
                <p className="imp-h" id={`h-${key}`}>{hint}</p>
              </div>
              <div className="imp-ctl">
                <span className={salvati[key] === '1' ? 'imp-on' : 'imp-off'}>{salvati[key] === '1' ? 'Acceso' : 'Spento'}</span>
                <Switch
                  id={key}
                  aria-label={label}
                  aria-describedby={`h-${key}`}
                  acceso={on}
                  disabled={!puoModificare || busy === key}
                  onCambia={(vuole) => chiedi(key, vuole ? '1' : '0')}
                />
              </div>
              {striscia(key, conferma?.dopo === '1' ? acceso : spento, conferma?.dopo === '1' ? 'Sì, accendi' : 'Sì, spegni')}
              <Piede esito={esiti[key]} cambio={cambi[key]} />
            </div>
          );
        })}
      </section>

      <section className="imp-sez" aria-labelledby="imp-mitt">
        <h2 id="imp-mitt">Mittente e blast</h2>
        {CAMPI_SCELTA.map(({ key, label, hint, opzioni }) => (
          <div key={key} className="imp-riga" role="group" aria-labelledby={`l-${key}`}>
            <div className="imp-tx">
              <label id={`l-${key}`} htmlFor={key} className="imp-l">{label}</label>
              <p className="imp-h">{hint}</p>
            </div>
            <div className="imp-ctl">
              <select
                id={key}
                className="imp-sel"
                value={conferma?.key === key ? conferma.dopo : salvati[key]}
                disabled={!puoModificare || busy === key}
                onChange={(e) => chiedi(key, e.target.value)}
              >
                {opzioni.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {striscia(key, null, 'Sì, salva')}
            <Piede esito={esiti[key]} cambio={cambi[key]} />
          </div>
        ))}
      </section>

      <section className="imp-sez" aria-labelledby="imp-link">
        <h2 id="imp-link">Quota, data e link</h2>
        {CAMPI_TESTO.map(({ key, label, hint, placeholder }) => (
          <div key={key} className="imp-riga imp-riga-testo" role="group" aria-labelledby={`l-${key}`}>
            <div className="imp-tx">
              <label id={`l-${key}`} htmlFor={key} className="imp-l">{label}</label>
              <p className="imp-h">{hint}</p>
            </div>
            <div className="imp-campo">
              <Input
                id={key}
                className={key === 'lancio_quota_secondario' ? 'imp-in num' : 'imp-in'}
                value={bozze[key]}
                placeholder={placeholder}
                disabled={!puoModificare}
                spellCheck={false}
                onChange={(e) => setBozze((v) => ({ ...v, [key]: e.target.value }))}
              />
              <Button
                disabled={!puoModificare || busy === key}
                caricamento={busy === key}
                onClick={() => chiedi(key, bozze[key].trim())}
              >
                Salva…
              </Button>
            </div>
            {striscia(key, null, 'Sì, salva')}
            <Piede esito={esiti[key]} cambio={cambi[key]} />
          </div>
        ))}
      </section>
    </div>
  );
}

/** Esito dell'ultimo salvataggio e ultimo cambio noto della chiave (chi e quando). */
function Piede({ esito, cambio }: { esito?: Esito; cambio?: UltimoCambio }) {
  if (!esito && !cambio) return null;
  return (
    <div className="imp-piede">
      {esito && (
        <p className={`imp-esito ${esito.tono}`} role={esito.tono === 'errore' ? 'alert' : 'status'}>
          {esito.tono !== 'ok' && <TriangleAlert size={16} strokeWidth={1.75} className="ico" />}
          <span>{esito.testo}</span>
        </p>
      )}
      {cambio && (
        <p className="imp-cambio">
          Ultima modifica <span className="mono">{cambio.at}</span>{cambio.who ? ` · ${cambio.who}` : ''}
        </p>
      )}
    </div>
  );
}
