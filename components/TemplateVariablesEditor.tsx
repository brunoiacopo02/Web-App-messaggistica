'use client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { X, Plus } from 'lucide-react';

type Var = { key: string; source: 'lead_field' | 'static'; value: string };

export function TemplateVariablesEditor({ value, onChange }: {
  value: Var[]; onChange: (v: Var[]) => void;
}) {
  function update(i: number, patch: Partial<Var>) {
    const next = [...value];
    next[i] = { ...next[i], ...patch } as Var;
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
    <div className="space-y-2">
      {value.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-sm text-zinc-500 w-12 font-mono">{`{{${v.key}}}`}</span>
          <Select value={v.source} onValueChange={(s) => update(i, { source: s as 'lead_field' | 'static', value: s === 'lead_field' ? 'first_name' : '' })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="lead_field">Campo lead</SelectItem>
              <SelectItem value="static">Valore statico</SelectItem>
            </SelectContent>
          </Select>
          {v.source === 'lead_field' ? (
            <Select value={v.value} onValueChange={(val) => update(i, { value: val })}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="first_name">Nome</SelectItem>
                <SelectItem value="last_name">Cognome</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="phone">Telefono</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input className="w-64" value={v.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="Es. Webinar Marzo" />
          )}
          <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)}>
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="size-3 mr-1" /> Aggiungi variabile
      </Button>
    </div>
  );
}
