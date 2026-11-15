"""Reuse existing seed metadata and reconcile it with public/Product_Images.

Default: read-only preview. --apply backs up the original seed directory before
updating catalogs and indexes. No research, dependencies, or database operations.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import html
import json
import re
import sys
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT))
from scripts.python.desiplus_full_seed import HierarchyHints, scan_local_images


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def normalized(value):
    value = unicodedata.normalize('NFKC', html.unescape(unquote(str(value or '')))).casefold()
    return re.sub(r'[^a-z0-9]', '', value.replace('&', 'and').replace('+', ' plus '))


def product_key(product):
    return (product.get('slug', ''), product.get('sku') or '')


def product_names(product):
    values = [product.get('name'), product.get('slug')]
    for url in [product.get('image'), product.get('sourceProductUrl'), *product.get('sourceImages', [])]:
        if url:
            values.append(Path(unquote(urlsplit(url).path)).stem)
    return {normalized(value) for value in values if value}


def build_plan(seed_root, image_root):
    if not seed_root.is_dir():
        raise ValueError(f'Seed directory does not exist: {seed_root}')
    catalogs, indexes, products = [], [], {}
    # Aggregate is authoritative when split copies describe the same identity.
    files = sorted(seed_root.rglob('*.json'), key=lambda p: (p.name != '_all.json', str(p)))
    for path in files:
        if 'reconciliation' in path.relative_to(seed_root).parts:
            continue
        data = read(path)
        if isinstance(data, dict) and isinstance(data.get('categories'), list) and isinstance(data.get('products'), list):
            catalogs.append(path)
            for product in data['products']:
                products.setdefault(product_key(product), product)
        elif isinstance(data, dict) and isinstance(data.get('groups'), list):
            indexes.append(path)
    lookup = defaultdict(set)
    for key, product in products.items():
        for name in product_names(product):
            lookup[name].add(key)
    records = scan_local_images(image_root, HierarchyHints())
    families, family_titles = defaultdict(list), {}
    for record in records:
        title = Path(unquote(urlsplit(record.image).path)).stem
        if record.sequence:
            title = re.sub(r'\s+0*' + str(record.sequence) + r'$', '', title)
        key = (record.folder_brand_slug, normalized(title))
        families[key].append(record)
        family_titles[key] = title
    matched, unmatched, ambiguous = defaultdict(list), [], []
    for family_key, family in sorted(families.items(), key=lambda item: str(item[0])):
        brand = family_key[0]
        stem = family_titles[family_key]
        candidates = lookup.get(normalized(stem), set())
        if not candidates:
            suffix = re.fullmatch(r'(.+?)(?:\s+|\s*\()(\d{1,2})\)?', stem)
            # A seed's exact existing name corroborates a lone photo suffix;
            # prefer the complete model name above (e.g. Infinix Xpad 20).
            if suffix and 1 <= int(suffix[2]) <= 5:
                candidates = lookup.get(normalized(suffix[1]), set())
                if candidates:
                    for record in family:
                        record.sequence = int(suffix[2])
                    stem = suffix[1]
        # Prefer the full product title to old URL/image aliases, which can be stale.
        exact_names = {key for key in candidates if normalized(products[key]['name']) == normalized(stem)}
        if exact_names:
            candidates = exact_names
        if len(candidates) > 1:
            verified = {key for key in candidates if not products[key].get('unmatched')
                        and not key[1].startswith('STARTECH-UNMATCHED-')}
            if verified:
                candidates = verified
        if len(candidates) > 1:
            brand_matches = {key for key in candidates
                             if normalized(products[key].get('brandName')) == normalized(brand)}
            if brand_matches:
                candidates = brand_matches
        if len(candidates) > 1 and len({key[1] for key in candidates}) == 1 and next(iter(candidates))[1]:
            # Identical named records with the same manufacturer SKU are source
            # duplicates. Keep one existing identity; do not create another SKU.
            candidates = {min(candidates, key=lambda key: (len(key[0]), key))}
        if len(candidates) == 1:
            matched[next(iter(candidates))].extend(family)
        else:
            entry = {'stem': stem, 'brand': brand, 'images': [r.image for r in family],
                     'candidates': [{'slug': key[0], 'sku': key[1], 'name': products[key]['name']}
                                    for key in sorted(candidates)]}
            (ambiguous if candidates else unmatched).append(entry)
    media = {}
    for key, family in matched.items():
        ordered = sorted(family, key=lambda r: (r.sequence, r.image.casefold(), r.image))
        urls = list(dict.fromkeys(r.image for r in ordered))
        media[key] = {'image': urls[0], 'gallery': urls[1:], 'sourceImages': urls,
                      'localImageFile': 'public' + unquote(urls[0])}
    summary = {'sourceProducts': len(products), 'sourceCatalogFiles': len(catalogs),
               'imageFiles': len(records), 'imageFamilies': len(families),
               'retainedProducts': len(media), 'removedProducts': len(products) - len(media),
               'matchedImages': sum(len(value['sourceImages']) for value in media.values()),
               'reviewImages': sum(len(e['images']) for e in ambiguous),
               'unmatchedFamilies': len(unmatched), 'ambiguousFamilies': len(ambiguous)}
    return dict(catalogs=catalogs, indexes=indexes, products=products, media=media,
                unmatched=unmatched, ambiguous=ambiguous, summary=summary)


def reconcile_catalog(data, media):
    updated = copy.deepcopy(data)
    retained = []
    for original in data['products']:
        replacement = media.get(product_key(original))
        if replacement is None:
            continue
        product = copy.deepcopy(original)
        product.update(replacement)
        # Old variant-specific photos must not point to the superseded asset tree.
        for variant in product.get('variants', []):
            if variant.get('colorImage'):
                variant['colorImage'] = replacement['image']
            options = variant.get('options')
            if isinstance(options, dict) and isinstance(options.get('__meta'), dict):
                meta = options['__meta']
                if 'image' in meta:
                    meta['image'] = replacement['image']
                if 'gallery' in meta:
                    meta['gallery'] = replacement['gallery']
        retained.append(product)
    updated['products'] = retained
    categories = {c['slug']: c for c in data['categories']}
    needed, category_images = set(), {}
    for product in retained:
        slug = product['categorySlug']
        visited = set()
        while slug:
            if slug in visited or slug not in categories:
                raise ValueError(f'Missing/cyclic category: {slug}')
            visited.add(slug)
            needed.add(slug)
            category_images.setdefault(slug, product['image'])
            slug = categories[slug].get('parentSlug')
    updated['categories'] = [dict(category, image=category_images[category['slug']])
                             for category in data['categories'] if category['slug'] in needed]
    brands = {normalized(p.get('brandName')) for p in retained}
    if 'brands' in updated:
        updated['brands'] = [b for b in data['brands'] if normalized(b['name']) in brands]
    if isinstance(updated.get('source'), dict):
        updated['source']['imageRoot'] = str(PROJECT / 'public' / 'Product_Images')
    return updated


def validate_catalog(data, image_root, checked=None):
    public = PROJECT / 'public'
    root = image_root.resolve()
    if checked is None:
        checked = set()
    for product in data['products']:
        urls = [product['image'], *product.get('gallery', []), *product.get('sourceImages', [])]
        if product['image'] in product.get('gallery', []):
            raise ValueError(f'Main repeated in gallery: {product["slug"]}')
        for url in set(urls):
            if url in checked:
                continue
            path = (public / unquote(url).lstrip('/')).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise ValueError(f'Missing/unsafe image: {url}')
            checked.add(url)


def apply_plan(plan, seed_root, image_root):
    if not plan['media']:
        raise ValueError('No confirmed image matches; refusing to empty the seed catalog')
    # Validate all output before replacing any source catalog.
    checked = set()
    for index, path in enumerate(plan['catalogs'], 1):
        validate_catalog(reconcile_catalog(read(path), plan['media']), image_root, checked)
        if index % 25 == 0:
            print(f'Validated {index}/{len(plan["catalogs"])} catalogs; {len(checked)} distinct images', flush=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = PROJECT / 'backups' / f'desiplus-seed-before-image-reconcile-{stamp}.zip'
    backup.parent.mkdir(parents=True, exist_ok=True)
    originals = sorted(p for p in seed_root.rglob('*') if p.is_file())
    with zipfile.ZipFile(backup, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in originals:
            archive.write(path, path.relative_to(seed_root))
    with zipfile.ZipFile(backup) as archive:
        if archive.testzip() is not None:
            raise ValueError('Backup integrity check failed')
    counts = {}
    for path in plan['catalogs']:
        data = reconcile_catalog(read(path), plan['media'])
        counts[path.resolve()] = len(data['products'])
        write(path, data)
    for path in plan['indexes']:
        data = read(path)
        groups = []
        for group in data['groups']:
            target = (path.parent / group['file']).resolve()
            if counts.get(target, 0):
                group.update(products=counts[target], matched=counts[target], unmatched=0)
                groups.append(group)
        data['groups'] = groups
        if 'imageFolder' in data:
            data['imageFolder'] = '/Product_Images'
        write(path, data)
    report_dir = seed_root / 'reconciliation'
    summary = dict(plan['summary'], backup=str(backup), appliedAt=datetime.now(timezone.utc).isoformat())
    write(report_dir / 'summary.json', summary)
    write(report_dir / 'unmatched-images.json', plan['unmatched'])
    write(report_dir / 'ambiguous-images.json', plan['ambiguous'])
    ambiguous_keys = {(candidate['slug'], candidate['sku'])
                      for entry in plan['ambiguous'] for candidate in entry['candidates']}
    write(report_dir / 'ambiguous-products.json', [
        plan['products'][key] for key in sorted(ambiguous_keys)])
    write(report_dir / 'removed-products.json', [
        {'slug': key[0], 'sku': key[1], 'name': product['name']}
        for key, product in plan['products'].items() if key not in plan['media']])
    write(report_dir / 'matched-products.json', [dict(slug=key[0], sku=key[1], **media)
                                               for key, media in sorted(plan['media'].items())])
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed-root', type=Path, default=PROJECT / 'prisma/Desi Plus Product Seed')
    parser.add_argument('--image-root', type=Path, default=PROJECT / 'public/Product_Images')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    plan = build_plan(args.seed_root, args.image_root)
    print(json.dumps(plan['summary'], indent=2))
    if args.apply:
        print(json.dumps(apply_plan(plan, args.seed_root, args.image_root), indent=2))
    else:
        print('Preview only. First unmatched families:')
        print(json.dumps(plan['unmatched'][:15], ensure_ascii=True, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
