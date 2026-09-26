'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Save, CheckCircle2, AlertTriangle, ShieldAlert } from 'lucide-react';
import type { LancioSettings, LancioSettingKey } from '@/lib/lancio-settings';

/** Tre toni, non due: una scrittura riuscita di cui non resta traccia nel registro non
 *  e' un errore (il valore e' nel DB) ma non e' nemmeno un "Salvato" liscio. */
type Esito = { tono: 'ok' | 'avviso' | 'errore'; text: string };
type Interruttore = 'lancio_attivo' | 'lancio_pulsante_attivo';

export type UltimoCambio = { at: string; who: string | null };

const ERRORI: Record<string, string> = {
  link_non_https: 'Serve un link completo che inizi con https://',
  data_non_valida: 'Serve una data ISO con fuso, es. 2026-10-05T21:00:00+02:00',
  chiave_non_modificabile: 'Questa impostazione non si cambia da qui.',
  valore_non_valido: 'Valore non valido.',
  sola_lettura: 'Il tuo account vede le impostazioni ma non le cambia.',
  scrittura_fallita: 'NON salvato: il database ha rifiutato la scrittura. Riprova, e se insiste cambiala in SQL.',
};

const INTERRUTTORI: Array<{ key: Interruttore; label: string; hint: string; acceso: string; spento: string }> = [
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

const CAMPI_TESTO: Array<{ key: LancioSettingKey; label: string; hint: string; placeholder: string }> = [
  {
    key: 'offerta_del_mese_link',
    label: 'Video offerta del mese',
    hint: 'Lo manda Marta quando il GDO sceglie “Offerta del mese” in agenda. Vuoto = nessun video (resta un avviso nei log).',
    placeholder: 'https://corso.feniceacademy.it/...',
  },
  {
    key: 'lancio_video_live_link',
    label: 'Video della live editata',
    hint: 'Lo manda Mario, al posto dei quattro video classici, a chi risponde al follow-up del giorno dopo. Vuoto = video classici.',
    placeholder: 'https://corso.feniceacademy.it/...',
  },
  {
    key: 'lancio_zoom_link',
    label: 'Link Zoom della live',
    hint: 'Lo manda il blast della sera dell’evento. Senza, il blast non parte.',
    placeholder: 'https://us06web.zoom.us/j/...',
  },
  {
    key: 'lancio_quota_secondario',
    label: 'Benvenuti verso i numeri secondari (%)',
    hint: 'Quota di riscaldamento verso i numeri secondari, solo sui benvenuti del lancio: 9 vuol dire uno da un secondario ogni dieci dal principale (la scelta fra i secondari e i loro tetti e’ di scegliMittenteNuovo). 0 (o vuoto) = tutti dal numero storico. Lo stesso lead finisce sempre sullo stesso numero, e se il template non e’ spedibile da nessun secondario parte comunque dal principale.',
    placeholder: '0',
  },
  {
    key: 'lancio_evento_at',
    label: 'Inizio della live (ISO con fuso)',
    hint: 'Da qui derivano blast, finestre del follow-up e data delle restituzioni. Non si azzera.',
    placeholder: '2026-10-05T21:00:00+02:00',
  },
];

const CAMPI_SCELTA: Array<{ key: LancioSettingKey; label: string; hint: string; opzioni: Array<{ value: string; label: string }> }> = [
  {
    key: 'lancio_blast_perimetro',
    label: 'Perimetro del blast Zoom',
    hint: '“Tutti” manda il link a chiunque sia in attesa o con il posto bloccato; “risposto” solo a chi ha scritto almeno una volta (piano B).',
    opzioni: [{ value: 'tutti', label: 'Tutti' }, { value: 'risposto', label: 'Solo chi ha risposto' }],
  },
  {
    key: 'lancio_sender',
    label: 'Mittente del lancio',
    hint: 'Vale sui benvenuti: “secondario” li manda tutti dal numero nuovo e batte la quota qui sotto. Blast Zoom e follow-up non sanno ancora partire dal secondario: lasciano un avviso nei log e partono dal principale.',
    opzioni: [{ value: 'principale', label: 'Numero principale' }, { value: 'secondario', label: 'Numero secondario' }],
  },
];

function valoriIniziali(s: LancioSettings): Record<LancioSettingKey, string> {
  return {
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

export function ImpostazioniLancioPanel({
  initial,
  cambi,
  puoModificare,
}: {
  initial: LancioSettings;
  cambi: Partial<Record<LancioSettingKey, UltimoCambio>>;
  puoModificare: boolean;
}) {
  const [valori, setValori] = useState<Record<LancioSettingKey, string>>(valoriIniziali(initial));
  const [esiti, setEsiti] = useState<Partial<Record<LancioSettingKey, Esito>>>({});
  const [busy, setBusy] = useState<LancioSettingKey | null>(null);
  /** L'interruttore in attesa di conferma: gira davvero solo dopo un secondo gesto. */
  const [conferma, setConferma] = useState<{ key: Interruttore; acceso: boolean } | null>(null);

  async function salva(key: LancioSettingKey, value: string | boolean) {
    setBusy(key);
    try {
      const res = await fetch('/api/fenice/lancio-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; errore?: string; value?: string | boolean; audit?: boolean;
      };
      if (!res.ok || !data.ok) {
        const motivo = data.errore ?? data.error ?? '';
        setEsiti((s) => ({ ...s, [key]: { tono: 'errore', text: ERRORI[motivo] ?? 'Errore di salvataggio' } }));
        return false;
      }
      // La scrittura è andata: `audit: false` dice solo che non ne resta traccia nel
      // registro. È un avviso, non un fallimento — ma non può passare per un "Salvato"
      // liscio, o la sera del 5 nessuno saprebbe che la cronologia ha un buco.
      const fatto = data.value === '' ? 'Azzerato' : 'Salvato';
      setEsiti((s) => ({
        ...s,
        [key]: data.audit === false
          ? { tono: 'avviso', text: `${fatto}, ma senza traccia nel registro` }
          : { tono: 'ok', text: fatto },
      }));
      return true;
    } catch {
      setEsiti((s) => ({ ...s, [key]: { tono: 'errore', text: 'Errore di rete: riprova' } }));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function confermaInterruttore() {
    if (!conferma) return;
    const { key, acceso } = conferma;
    setConferma(null);
    const fatto = await salva(key, acceso);
    if (fatto) setValori((v) => ({ ...v, [key]: acceso ? '1' : '0' }));
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      {!puoModificare && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div>Il tuo account vede le impostazioni ma non le cambia.</div>
        </div>
      )}

      {INTERRUTTORI.map(({ key, label, hint, acceso, spento }) => {
        const on = valori[key] === '1';
        const inAttesa = conferma?.key === key;
        return (
          <div key={key} className="fenice-rise rounded-2xl border border-border/70 bg-card/60 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{label}</div>
                <div className="text-xs text-muted-foreground">{hint}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`text-xs font-semibold ${on ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                  {on ? 'Acceso' : 'Spento'}
                </span>
                <Switch
                  id={key}
                  aria-label={label}
                  checked={inAttesa ? conferma.acceso : on}
                  disabled={!puoModificare || busy === key}
                  onCheckedChange={(vuole: boolean) => setConferma({ key, acceso: vuole })}
                />
              </div>
            </div>

            {inAttesa && (
              <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                <div className="flex items-start gap-2 text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                  <div>
                    <div className="font-semibold">
                      {conferma.acceso ? `Accendere “${label}”?` : `Spegnere “${label}”?`}
                    </div>
                    <div className="text-muted-foreground">{conferma.acceso ? acceso : spento}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy === key}
                    onClick={() => void confermaInterruttore()}
                  >
                    {conferma.acceso ? 'Sì, accendi' : 'Sì, spegni'}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setConferma(null)}>
                    Annulla
                  </Button>
                </div>
              </div>
            )}

            <PiedeCampo esito={esiti[key]} cambio={cambi[key]} />
          </div>
        );
      })}

      {CAMPI_TESTO.map(({ key, label, hint, placeholder }) => (
        <div key={key} className="fenice-rise rounded-2xl border border-border/70 bg-card/60 p-5">
          <Label htmlFor={key} className="text-sm font-semibold">{label}</Label>
          <div className="mb-3 text-xs text-muted-foreground">{hint}</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={key}
              value={valori[key]}
              placeholder={placeholder}
              disabled={!puoModificare}
              onChange={(e) => setValori((v) => ({ ...v, [key]: e.target.value }))}
            />
            <Button
              type="button"
              className="shrink-0"
              disabled={!puoModificare || busy === key}
              onClick={() => void salva(key, valori[key].trim())}
            >
              <Save className="mr-1.5 size-4" /> Salva
            </Button>
          </div>
          <PiedeCampo esito={esiti[key]} cambio={cambi[key]} />
        </div>
      ))}

      {CAMPI_SCELTA.map(({ key, label, hint, opzioni }) => (
        <div key={key} className="fenice-rise rounded-2xl border border-border/70 bg-card/60 p-5">
          <Label htmlFor={key} className="text-sm font-semibold">{label}</Label>
          <div className="mb-3 text-xs text-muted-foreground">{hint}</div>
          <select
            id={key}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto"
            value={valori[key]}
            disabled={!puoModificare || busy === key}
            onChange={(e) => {
              const value = e.target.value;
              const prima = valori[key];
              setValori((v) => ({ ...v, [key]: value }));
              // Se il salvataggio non passa, il menu non puo' restare sulla scelta
              // nuova: mostrerebbe un perimetro o un mittente che nel DB non c'e'.
              void salva(key, value).then((fatto) => {
                if (!fatto) setValori((v) => ({ ...v, [key]: prima }));
              });
            }}
          >
            {opzioni.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <PiedeCampo esito={esiti[key]} cambio={cambi[key]} />
        </div>
      ))}
    </div>
  );
}

const TONO: Record<Esito['tono'], string> = {
  ok: 'text-emerald-600',
  avviso: 'text-amber-600',
  errore: 'text-red-600',
};

/** Esito dell'ultimo salvataggio + l'ultimo cambio noto della chiave (chi e quando). */
function PiedeCampo({ esito, cambio }: { esito?: Esito; cambio?: UltimoCambio }) {
  if (!esito && !cambio) return null;
  return (
    <div className="mt-2 space-y-1">
      {esito && (
        <div className={`flex items-center gap-1.5 text-xs ${TONO[esito.tono]}`}>
          {esito.tono === 'ok' ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
          {esito.text}
        </div>
      )}
      {cambio && (
        <div className="text-[0.7rem] text-muted-foreground">
          Ultima modifica: {cambio.at}{cambio.who ? ` · ${cambio.who}` : ''}
        </div>
      )}
    </div>
  );
}
