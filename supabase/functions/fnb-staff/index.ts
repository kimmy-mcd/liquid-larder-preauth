// F&B pipeline — Stage A backend (products, per-venue price history, supplier imports).
// Permissions via hub_can on app_slug 'fnb':
//   view_products / manage_products / view_costs / import_products
import { createClient } from 'jsr:@supabase/supabase-js@2';

const PROD_ORIGIN = 'https://hub.liquidandlarder.com.au';
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function corsFor(origin: string | null) {
  const allow = origin && (origin === PROD_ORIGIN || PREVIEW_RE.test(origin)) ? origin : PROD_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const UNITS = ['g', 'ml', 'each'];

function sydneyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}

// ---------------------------------------------------------------- conversion
// Suggest a pack -> base-unit conversion from the product name / pack text.
// Deterministic, explainable, and always confirmed by a human before it is
// trusted for costing (conversion_source stays 'ai' until someone confirms).
export function suggestConversion(text: string): { pack_qty: number; base_unit: string; why: string } | null {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  const num = '(\\d+(?:\\.\\d+)?)';
  // multipliers: "12 x 500ml", "6x1kg"
  const mult = t.match(new RegExp(`${num}\\s*[x×]\\s*${num}\\s*(kg|g|l|lt|ltr|litre|liter|ml)\\b`));
  if (mult) {
    const count = parseFloat(mult[1]), size = parseFloat(mult[2]), u = mult[3];
    const [qty, unit] = toBase(size, u);
    return { pack_qty: round(count * qty), base_unit: unit, why: `${count} × ${size}${u}` };
  }
  const multEach = t.match(new RegExp(`${num}\\s*[x×]\\s*(?:ea|each|pc|pcs|piece|pieces|unit|units)\\b`));
  if (multEach) return { pack_qty: parseFloat(multEach[1]), base_unit: 'each', why: `${multEach[1]} each` };
  // plain size: "5kg", "700ml", "1.5 l"
  const plain = t.match(new RegExp(`${num}\\s*(kg|g|l|lt|ltr|litre|liter|ml)\\b`));
  if (plain) {
    const [qty, unit] = toBase(parseFloat(plain[1]), plain[2]);
    return { pack_qty: round(qty), base_unit: unit, why: `${plain[1]}${plain[2]}` };
  }
  // countable packs: "tray of 30", "dozen"
  const of = t.match(new RegExp(`(?:pack|box|tray|carton|punnet|dozen)\\s*(?:of)?\\s*${num}\\b`));
  if (of) return { pack_qty: parseFloat(of[1]), base_unit: 'each', why: `pack of ${of[1]}` };
  if (/\bdozen\b/.test(t)) return { pack_qty: 12, base_unit: 'each', why: 'dozen' };
  if (/\b(ea|each|unit|punnet|head|bunch)\b/.test(t)) return { pack_qty: 1, base_unit: 'each', why: 'single unit' };
  return null;
}

function toBase(n: number, u: string): [number, string] {
  if (u === 'kg') return [n * 1000, 'g'];
  if (u === 'g') return [n, 'g'];
  if (u === 'ml') return [n, 'ml'];
  return [n * 1000, 'ml']; // l / lt / ltr / litre / liter
}
const round = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------- csv
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const ALIASES: Record<string, string[]> = {
  supplier: ['supplier', 'supplier name', 'vendor', 'contact', 'contact name', 'creditor'],
  supplier_code: ['code', 'product code', 'sku', 'item code', 'supplier code', 'item no', 'part number'],
  name: ['name', 'description', 'product', 'item', 'item description', 'product name', 'line description'],
  pack_description: ['pack', 'pack size', 'unit', 'uom', 'size', 'pack description'],
  pack_price: ['price', 'unit price', 'rate', 'cost', 'unit cost', 'ex gst', 'amount', 'net amount'],
};

export function detectMapping(header: string[]): Record<string, number> {
  const norm = header.map((h) => String(h).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '));
  const map: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    let idx = norm.findIndex((h) => aliases.includes(h));
    if (idx < 0) idx = norm.findIndex((h) => aliases.some((a) => h.includes(a)));
    if (idx >= 0) map[field] = idx;
  }
  return map;
}

function money(v: string): number | null {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// ---------------------------------------------------------------- serve
Deno.serve(async (req) => {
  const CORS = corsFor(req.headers.get('origin'));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'Not signed in' }, 401);
    const { data: profile } = await admin.from('portal_profiles').select('active, email').eq('id', user.id).maybeSingle();
    if (!profile || !profile.active) return json({ error: 'Your account does not have hub access' }, 403);
    const email = profile.email as string;

    // deno-lint-ignore no-explicit-any
    const can = async (action: string) => {
      const { data, error } = await admin.rpc('hub_can', { p_user: user.id, p_app_slug: 'fnb', p_action_key: action });
      if (error) throw new Error('permission check failed: ' + error.message);
      return data === true;
    };
    const [canView, canManage, canCosts, canImport] = await Promise.all(
      ['view_products', 'manage_products', 'view_costs', 'import_products'].map(can),
    );
    const deny = (what: string) => json({ error: `Your hub permissions do not include ${what}` }, 403);

    const body = await req.json();
    const action = body.action;

    // ------------------------------------------------------------ bootstrap
    if (action === 'bootstrap') {
      if (!canView) return deny('the F&B products list');
      const [{ data: venues }, { data: dietaries }, { data: categories }] = await Promise.all([
        admin.from('hub_venues').select('id, name, is_head_office').eq('active', true).order('sort_order'),
        admin.from('fnb_dietaries').select('id, name, kind, sort_order').eq('active', true).order('sort_order'),
        admin.from('fnb_menu_categories').select('id, name, sort_order').eq('active', true).order('sort_order'),
      ]);
      return json({
        ok: true, venues, dietaries, categories, email,
        can_manage: canManage, can_costs: canCosts, can_import: canImport,
      });
    }

    // ------------------------------------------------------------ products
    if (action === 'list_products') {
      if (!canView) return deny('the F&B products list');
      let q = admin.from('fnb_products')
        .select('id, name, supplier, supplier_code, category, pack_description, pack_qty, base_unit, conversion_source, conversion_confirmed_at, source, active, notes, updated_at')
        .order('name')
        .limit(1000);
      if (body.search) {
        const s = String(body.search).replace(/[%,()]/g, ' ').trim();
        if (s) q = q.or(`name.ilike.%${s}%,supplier.ilike.%${s}%,supplier_code.ilike.%${s}%`);
      }
      if (body.active !== false) q = q.eq('active', true);
      if (body.source) q = q.eq('source', body.source);
      const { data: products, error } = await q;
      if (error) return json({ error: error.message }, 500);

      let costs: Record<string, unknown> = {};
      if (canCosts && body.venue_id) {
        const { data: rows } = await admin.from('fnb_product_current_cost')
          .select('product_id, pack_price_cents, pack_qty, base_unit, unit_cost, effective_date, source')
          .eq('venue_id', body.venue_id);
        costs = Object.fromEntries((rows ?? []).map((r) => [r.product_id, r]));
      }
      return json({ ok: true, products, costs, can_costs: canCosts });
    }

    if (action === 'suggest_conversion') {
      if (!canView) return deny('the F&B products list');
      const s = suggestConversion([body.pack_description, body.name].filter(Boolean).join(' '));
      return json({ ok: true, suggestion: s });
    }

    if (action === 'save_product') {
      if (!canManage) return deny('adding or editing products');
      const name = String(body.name ?? '').trim();
      if (!name) return json({ error: 'Product name is required' }, 400);
      if (body.base_unit && !UNITS.includes(body.base_unit)) return json({ error: 'Invalid base unit' }, 400);
      const packQty = body.pack_qty === '' || body.pack_qty == null ? null : Number(body.pack_qty);
      if (packQty !== null && (!Number.isFinite(packQty) || packQty <= 0)) {
        return json({ error: 'Pack quantity must be a positive number' }, 400);
      }
      if ((packQty === null) !== (!body.base_unit)) {
        return json({ error: 'Set both a pack quantity and a base unit, or neither' }, 400);
      }
      const fields = {
        name,
        supplier: String(body.supplier ?? '').trim() || null,
        supplier_code: String(body.supplier_code ?? '').trim() || null,
        category: String(body.category ?? '').trim() || null,
        pack_description: String(body.pack_description ?? '').trim() || null,
        pack_qty: packQty,
        base_unit: body.base_unit || null,
        notes: String(body.notes ?? '').trim() || null,
        active: body.active !== false,
        conversion_source: body.conversion_source === 'ai' ? 'ai' : 'manual',
        conversion_confirmed_at: packQty !== null ? new Date().toISOString() : null,
        conversion_confirmed_by: packQty !== null ? email : null,
      };

      let productId = body.id as string | undefined;
      if (productId) {
        const { error } = await admin.from('fnb_products').update(fields).eq('id', productId);
        if (error) return json({ error: error.message }, 500);
      } else {
        const { data, error } = await admin.from('fnb_products')
          .insert({ ...fields, source: 'manual', created_by: email }).select('id').single();
        if (error) {
          if (error.code === '23505') return json({ error: 'A product with that supplier and code already exists' }, 400);
          return json({ error: error.message }, 500);
        }
        productId = data.id;
      }

      // Optional price for a venue, recorded against today (Sydney).
      if (body.venue_id && body.pack_price != null && String(body.pack_price) !== '') {
        const cents = money(String(body.pack_price));
        if (cents === null) return json({ error: 'Invalid pack price' }, 400);
        const { error } = await admin.from('fnb_product_prices').upsert({
          product_id: productId, venue_id: body.venue_id, pack_price_cents: cents,
          pack_qty: packQty, base_unit: fields.base_unit,
          effective_date: sydneyToday(), source: 'manual', created_by: email,
        }, { onConflict: 'product_id,venue_id,effective_date' });
        if (error) return json({ error: error.message }, 500);
      }

      await admin.from('hub_audit_log').insert({
        actor_user_id: user.id,
        event: body.id ? 'fnb.product_updated' : 'fnb.product_created',
        detail: { product_id: productId, name },
      });
      return json({ ok: true, id: productId });
    }

    if (action === 'price_history') {
      if (!canCosts) return deny('product costs');
      const { data, error } = await admin.from('fnb_product_prices')
        .select('venue_id, pack_price_cents, pack_qty, base_unit, effective_date, source, created_by')
        .eq('product_id', body.product_id)
        .order('effective_date', { ascending: false }).limit(200);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, prices: data });
    }

    // ------------------------------------------------------------ imports
    if (action === 'import_preview') {
      if (!canImport) return deny('supplier price imports');
      const venueId = body.venue_id;
      if (!venueId) return json({ error: 'Choose a venue for this import' }, 400);
      const { data: venue } = await admin.from('hub_venues').select('id').eq('id', venueId).eq('active', true).maybeSingle();
      if (!venue) return json({ error: 'Unknown venue' }, 400);
      const rows = parseCsv(String(body.csv ?? ''));
      if (rows.length < 2) return json({ error: 'That file has no data rows' }, 400);
      const header = rows[0];
      const mapping = { ...detectMapping(header), ...(body.mapping ?? {}) };
      for (const need of ['name', 'pack_price']) {
        if (mapping[need] == null) {
          return json({ error: `Could not find a "${need.replace('_', ' ')}" column. Columns found: ${header.join(', ')}`, header, mapping }, 400);
        }
      }

      const { data: imp, error: impErr } = await admin.from('fnb_imports').insert({
        venue_id: venueId, filename: String(body.filename ?? '').slice(0, 200) || null,
        status: 'preview', uploaded_by: email,
      }).select('id').single();
      if (impErr) return json({ error: impErr.message }, 500);

      const cell = (r: string[], f: string) => (mapping[f] == null ? '' : String(r[mapping[f]] ?? '').trim());
      const out: Record<string, unknown>[] = [];
      let nNew = 0, nPrice = 0, nSame = 0, nErr = 0;

      // Existing catalogue, keyed on supplier|code for matching.
      const { data: existing } = await admin.from('fnb_products').select('id, name, supplier, supplier_code');
      const key = (s: string, c: string) => `${(s || '').toLowerCase()}|${(c || '').toLowerCase()}`;
      const byCode = new Map((existing ?? []).filter((p) => p.supplier_code).map((p) => [key(p.supplier ?? '', p.supplier_code!), p.id]));
      const byName = new Map((existing ?? []).map((p) => [String(p.name).toLowerCase(), p.id]));

      const { data: current } = await admin.from('fnb_product_current_cost')
        .select('product_id, pack_price_cents').eq('venue_id', venueId);
      const priceNow = new Map((current ?? []).map((c) => [c.product_id, c.pack_price_cents]));

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = cell(r, 'name');
        const cents = money(cell(r, 'pack_price'));
        const supplier = cell(r, 'supplier');
        const code = cell(r, 'supplier_code');
        const pack = cell(r, 'pack_description');
        let matched: string | null = null;
        let act = 'unchanged', err: string | null = null;

        if (!name) { act = 'error'; err = 'No product name'; }
        else if (cents === null) { act = 'error'; err = 'No usable price'; }
        else {
          matched = (code ? byCode.get(key(supplier, code)) : null) ?? byName.get(name.toLowerCase()) ?? null;
          if (!matched) act = 'new';
          else act = priceNow.get(matched) === cents ? 'unchanged' : 'price_change';
        }
        if (act === 'error') nErr++; else if (act === 'new') nNew++; else if (act === 'price_change') nPrice++; else nSame++;
        out.push({
          import_id: imp.id, line_no: i, raw: r, supplier: supplier || null, supplier_code: code || null,
          name: name || null, pack_description: pack || null, pack_price_cents: cents,
          action: act, matched_product_id: matched, error: err,
        });
      }

      for (let i = 0; i < out.length; i += 500) {
        const { error } = await admin.from('fnb_import_rows').insert(out.slice(i, i + 500));
        if (error) return json({ error: error.message }, 500);
      }
      await admin.from('fnb_imports').update({
        row_count: out.length, new_count: nNew, price_change_count: nPrice,
        unchanged_count: nSame, error_count: nErr,
      }).eq('id', imp.id);

      return json({
        ok: true, import_id: imp.id, header, mapping,
        summary: { rows: out.length, new: nNew, price_change: nPrice, unchanged: nSame, errors: nErr },
        preview: out.slice(0, 300).map((o) => ({
          line_no: o.line_no, name: o.name, supplier: o.supplier, supplier_code: o.supplier_code,
          pack_description: o.pack_description, pack_price_cents: o.pack_price_cents,
          action: o.action, error: o.error,
        })),
      });
    }

    if (action === 'import_commit') {
      if (!canImport) return deny('supplier price imports');
      const { data: imp } = await admin.from('fnb_imports').select('*').eq('id', body.import_id).maybeSingle();
      if (!imp) return json({ error: 'Import not found' }, 404);
      if (imp.status !== 'preview') return json({ error: `This import is already ${imp.status}` }, 400);
      const { data: rows } = await admin.from('fnb_import_rows').select('*').eq('import_id', imp.id).order('line_no');
      const today = sydneyToday();
      let created = 0, priced = 0;

      for (const r of rows ?? []) {
        if (r.action === 'error' || r.action === 'skipped' || r.pack_price_cents == null) continue;
        let productId = r.matched_product_id as string | null;
        if (!productId) {
          const guess = suggestConversion([r.pack_description, r.name].filter(Boolean).join(' '));
          const { data: p, error } = await admin.from('fnb_products').insert({
            name: r.name, supplier: r.supplier, supplier_code: r.supplier_code,
            pack_description: r.pack_description,
            pack_qty: guess?.pack_qty ?? null, base_unit: guess?.base_unit ?? null,
            conversion_source: guess ? 'ai' : 'manual',
            source: 'lightyear', created_by: email,
          }).select('id').single();
          if (error) continue;
          productId = p.id; created++;
          await admin.from('fnb_import_rows').update({ matched_product_id: productId }).eq('id', r.id);
        } else {
          // A manual product seen in a real supplier file is now Lightyear-backed.
          await admin.from('fnb_products').update({ source: 'lightyear' })
            .eq('id', productId).eq('source', 'manual');
        }
        const { error: pe } = await admin.from('fnb_product_prices').upsert({
          product_id: productId, venue_id: imp.venue_id, pack_price_cents: r.pack_price_cents,
          effective_date: today, source: 'lightyear', import_id: imp.id, created_by: email,
        }, { onConflict: 'product_id,venue_id,effective_date' });
        if (!pe) priced++;
      }

      await admin.from('fnb_imports').update({ status: 'committed', committed_by: email, committed_at: new Date().toISOString() }).eq('id', imp.id);
      await admin.from('hub_audit_log').insert({
        actor_user_id: user.id, event: 'fnb.import_committed',
        detail: { import_id: imp.id, venue_id: imp.venue_id, created, priced },
      });
      return json({ ok: true, created, priced });
    }

    if (action === 'import_discard') {
      if (!canImport) return deny('supplier price imports');
      const { error } = await admin.from('fnb_imports').update({ status: 'discarded' })
        .eq('id', body.import_id).eq('status', 'preview');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'list_imports') {
      if (!canImport) return deny('supplier price imports');
      const { data, error } = await admin.from('fnb_imports').select('*')
        .order('uploaded_at', { ascending: false }).limit(50);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, imports: data });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
