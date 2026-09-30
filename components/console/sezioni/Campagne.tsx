'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, TriangleAlert, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Sheet } from '../ui/Sheet';
import { Switch } from '../ui/Switch';
import { Tag } from '../ui/Tag';
import { Vuoto } from '../ui/Stato';
import { toast } from '../ui/toast';

/**
 * Campagne (porta `/campagne`): la tabella e il pannello di `CampaignDrawer`, con gli stessi campi,
 * lo stesso corpo e le stesse rotte (`POST /api/campaigns`, `PATCH /api/campaigns/[id]`). Le
 * validazioni restano quelle del server (`CampaignSchema`). In più, un gesto: prima di scrivere il
 * pannello dice cosa succede, perché una campagna accesa manda template WhatsApp ai lead.
 */

type Variabile = { key: string; source: 'lead_field' | 'static'; value: string };

export type Campagna = {
  id?: number;
  name: string;
  ac_list_match: string;
  twilio_template_sid: string;
  template_variables: Variabile[];
  active: boolean;
};

const NUOVA: Campagna = { name: '', ac_list_match: '', twilio_template_sid: '', template_variables: [], active: true };

const CAMPO: Record<string, string> = {
  name: 'Nome',
  ac_list_match: 'Lista AC trigger',
  twilio_template_sid: 'Template Content SID',
  template_variables: 'Variabili template',
  active: 'Attiva',
};

const CAMPI_LEAD: Array<{ value: string; label: string }> = [
  { value: 'first_name', label: 'Nome' },
  { value: 'last_name', label: 'Cognome' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Telefono' },
];

const ICONA = { size: 16, strokeWidth: 1.75, className: 'ico', 'aria-hidden': true } as const;

/** Lo stesso corpo del drawer vecchio, campo per campo. */
function corpo(c: Campagna) {
  return {
    name: c.name, ac_list_match: c.ac_list_match,
    twilio_template_sid: c.twilio_template_sid,
    template_variables: c.template_variables, active: c.active,
  };
}

/** L'errore della rotta in parole: i campi di `CampaignSchema` col loro nome, altrimenti il codice. */
function motivo(j: { error?: string; details?: { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> } }): string {
  const d = j.details;
  if (d) {
    const campi = Object.entries(d.fieldErrors ?? {})
      .filter(([, m]) => m && m.length > 0)
      .map(([k, m]) => `${CAMPO[k] ?? k}: ${m!.join(', ')}`);
    const tutti = [...(d.formErrors ?? []), ...campi];
    if (tutti.length > 0) return tutti.join('; ');
    return JSON.stringify(d);
  }
  return j.error ?? 'Errore';
}

function variabiliLeggibili(v: readonly Variabile[]): string {
  if (v.length === 0) return 'nessuna';
  return v.map((x) => `{{${x.key}}} ${x.source === 'static' ? `“${x.value}”` : CAMPI_LEAD.find((f) => f.value === x.value)?.label ?? x.value}`).join(', ');
}

/** Le differenze da mostrare prima → dopo quando si modifica una campagna esistente. */
function differenze(prima: Campagna, dopo: Campagna): Array<{ campo: string; prima: string; dopo: string }> {
  const out: Array<{ campo: string; prima: string; dopo: string }> = [];
  for (const k of ['name', 'ac_list_match', 'twilio_template_sid'] as const) {
    if (prima[k] !== dopo[k]) out.push({ campo: CAMPO[k], prima: prima[k] || '(vuoto)', dopo: dopo[k] || '(vuoto)' });
  }
  const vp = variabiliLeggibili(prima.template_variables);
  const vd = variabiliLeggibili(dopo.template_variables);
  if (vp !== vd) out.push({ campo: CAMPO.template_variables, prima: vp, dopo: vd });
  if (prima.active !== dopo.active) out.push({ campo: 'Stato', prima: prima.active ? 'Accesa' : 'Spenta', dopo: dopo.active ? 'Accesa' : 'Spenta' });
  return out;
}

export function Campagne({ campagne }: { campagne: Campagna[] }) {
  const [aperta, setAperta] = useState<Campagna | null>(null);

  return (
    <div className="avv cmp-pag">
      <header className="avv-hd">
        <h1>Campagne</h1>
        <span className="avv-agg">Una campagna accesa manda il suo template a ogni lead che ActiveCampaign porta dalla sua lista.</span>
        <span className="sp" />
        <Button variante="primario" onClick={() => setAperta(NUOVA)}>
          <Plus {...ICONA} />
          Nuova campagna…
        </Button>
      </header>

      {campagne.length === 0 ? (
        <Vuoto titolo="Nessuna campagna ancora" testo="Crea la prima con “Nuova campagna…”: prima di salvarla il pannello ti dice cosa manderà." />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl cmp-tbl">
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Lista AC</th>
                <th scope="col">Template SID</th>
                <th scope="col" className="r">Variabili</th>
                <th scope="col">Stato</th>
                <th scope="col"><span className="sr-only">Modifica</span></th>
              </tr>
            </thead>
            <tbody>
              {campagne.map((c) => (
                <tr key={c.id}>
                  <td className="cmp-nm">{c.name}</td>
                  <td className="mono">{c.ac_list_match}</td>
                  <td className="mono">{c.twilio_template_sid}</td>
                  <td className="r num">{c.template_variables?.length ?? 0}</td>
                  <td>{c.active ? <Tag tono="ok">Attiva</Tag> : <Tag tono="neutro">Disattivata</Tag>}</td>
                  <td className="cmp-x">
                    <button type="button" className="iconbtn" aria-label={`Modifica ${c.name}…`} onClick={() => setAperta(c)}>
                      <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet
        aperto={aperta !== null}
        onCambia={(v) => { if (!v) setAperta(null); }}
        titolo={aperta?.id ? 'Modifica campagna' : 'Nuova campagna'}
      >
        {aperta && <Modulo key={aperta.id ?? 'nuova'} iniziale={aperta} onFatto={() => setAperta(null)} />}
      </Sheet>
    </div>
  );
}

function Modulo({ iniziale, onFatto }: { iniziale: Campagna; onFatto: () => void }) {
  const router = useRouter();
  const [c, setC] = useState<Campagna>(iniziale);
  const [fase, setFase] = useState<'modulo' | 'conferma'>('modulo');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nuova = !c.id;

  async function save() {
    setBusy(true); setErr(null);
    const url = c.id ? `/api/campaigns/${c.id}` : '/api/campaigns';
    let res: Response;
    try {
      res = await fetch(url, {
        method: c.id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo(c)),
      });
    } catch {
      setBusy(false);
      setFase('modulo');
      setErr('Non salvata: errore di rete. Nulla è cambiato: riprova.');
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({} as Record<string, never>));
      setFase('modulo');
      setErr(`Non salvata: ${motivo(j)}`);
      return;
    }
    toast.ok(nuova ? 'Campagna creata' : 'Campagna salvata');
    onFatto();
    router.refresh();
  }

  if (fase === 'conferma') {
    const diff = nuova ? [] : differenze(iniziale, c);
    const verbo = nuova ? (c.active ? 'Sì, crea e accendi' : 'Sì, crea spenta') : 'Sì, salva';
    return (
      <div className="imp-conf cmp-conf" role="group" aria-label="Conferma la campagna">
        <p className="imp-conf-t">{nuova ? `Creare la campagna “${c.name}”?` : `Salvare le modifiche a “${c.name}”?`}</p>
        {!nuova && (
          diff.length === 0 ? (
            <p className="imp-conf-m">Nessun campo è cambiato.</p>
          ) : (
            <dl className="cmp-diff">
              {diff.map((d) => (
                <div key={d.campo}><dt>{d.campo}</dt><dd className="mono">{d.prima} → {d.dopo}</dd></div>
              ))}
            </dl>
          )
        )}
        {c.active ? (
          <p className="imp-conf-m">
            Accesa: da quando la salvi, ogni lead che ActiveCampaign manda dalla lista <b className="mono">{c.ac_list_match || '(vuota)'}</b> riceve
            in automatico il template <b className="mono">{c.twilio_template_sid || '(vuoto)'}</b> su WhatsApp. Quanti saranno non si sa in
            anticipo: dipende da quanti lead entrano nella lista.
          </p>
        ) : (
          <p className="imp-conf-m">
            Spenta: non parte nessun messaggio finché non la accendi.
            {!nuova && iniziale.active ? ' I lead nuovi della lista smettono di ricevere il template.' : ''}
          </p>
        )}
        <div className="imp-conf-act">
          <Button variante="primario" caricamento={busy} onClick={() => void save()}>{verbo}</Button>
          <Button variante="fantasma" disabled={busy} onClick={() => setFase('modulo')}>Torna al modulo</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="cmp-form"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        setFase('conferma');
      }}
    >
      <div className="cmp-campo">
        <label htmlFor="cmp-nome">Nome</label>
        <Input id="cmp-nome" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="Es. Webinar Marzo" />
      </div>
      <div className="cmp-campo">
        <label htmlFor="cmp-lista">Lista AC trigger</label>
        <Input
          id="cmp-lista"
          className="cmp-in-mono"
          aria-describedby="cmp-lista-h"
          value={c.ac_list_match}
          onChange={(e) => setC({ ...c, ac_list_match: e.target.value })}
          placeholder="Nome esatto della lista o ID"
        />
        <p id="cmp-lista-h" className="cmp-h">Inserisci il nome esatto della lista o l&apos;ID che AC passa nel webhook.</p>
      </div>
      <div className="cmp-campo">
        <label htmlFor="cmp-sid">Template Content SID</label>
        <Input
          id="cmp-sid"
          className="cmp-in-mono"
          spellCheck={false}
          value={c.twilio_template_sid}
          onChange={(e) => setC({ ...c, twilio_template_sid: e.target.value })}
          placeholder="HX..."
        />
      </div>
      <fieldset className="cmp-campo cmp-vars">
        <legend>Variabili template</legend>
        <EditorVariabili value={c.template_variables ?? []} onChange={(vars) => setC({ ...c, template_variables: vars })} />
      </fieldset>
      <div className="cmp-att">
        <Switch id="cmp-attiva" aria-label="Attiva" acceso={c.active} onCambia={(v) => setC({ ...c, active: v })} />
        <label htmlFor="cmp-attiva">Attiva</label>
        <span className="muted">{c.active ? 'manda il template ai lead nuovi della lista' : 'non manda nulla'}</span>
      </div>
      {err && (
        <p className="cmp-err" role="alert">
          <TriangleAlert {...ICONA} />
          <span>{err}</span>
        </p>
      )}
      <div className="cmp-piede">
        <Button type="submit" variante="primario">{nuova ? 'Crea…' : 'Salva…'}</Button>
      </div>
    </form>
  );
}

/** L'editor delle variabili di `TemplateVariablesEditor`, con la stessa logica: chiavi 1..n
 *  rinumerate a ogni rimozione, una variabile nuova parte da "Campo lead: Nome". */
function EditorVariabili({ value, onChange }: { value: Variabile[]; onChange: (v: Variabile[]) => void }) {
  function update(i: number, patch: Partial<Variabile>) {
    const next = [...value];
    next[i] = { ...next[i], ...patch } as Variabile;
    onChange(next);
  }
  function add() {
    const nextKey = String(value.length + 1);
    onChange([...value, { key: nextKey, source: 'lead_field', value: 'first_name' }]);
  }
  function remove(i: number) {
    const next = value.filter((_, idx) => idx !== i).map((v, idx) => ({ ...v, key: String(idx + 1) }));
    onChange(next);
  }

  return (
    <div className="cmp-vars-l">
      {value.map((v, i) => (
        <div key={i} className="cmp-var">
          <span className="mono cmp-var-k">{`{{${v.key}}}`}</span>
          <select
            aria-label={`Origine di {{${v.key}}}`}
            value={v.source}
            onChange={(e) => update(i, { source: e.target.value as Variabile['source'], value: e.target.value === 'lead_field' ? 'first_name' : '' })}
          >
            <option value="lead_field">Campo lead</option>
            <option value="static">Valore statico</option>
          </select>
          {v.source === 'lead_field' ? (
            <select aria-label={`Campo di {{${v.key}}}`} value={v.value} onChange={(e) => update(i, { value: e.target.value })}>
              {CAMPI_LEAD.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          ) : (
            <Input
              className="cmp-var-in"
              aria-label={`Valore di {{${v.key}}}`}
              value={v.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder="Es. Webinar Marzo"
            />
          )}
          <button type="button" className="iconbtn" aria-label={`Togli {{${v.key}}}`} onClick={() => remove(i)}>
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      ))}
      <Button onClick={add}>
        <Plus {...ICONA} />
        Aggiungi variabile
      </Button>
    </div>
  );
}
