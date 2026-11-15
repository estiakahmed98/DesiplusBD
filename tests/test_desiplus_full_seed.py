import contextlib
import copy
import io
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from scripts.python import desiplus_full_seed as seed


class LocalSeedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.root = self.repo / 'public' / 'Product_Images'
        self.root.mkdir(parents=True)
        self.project_patch = patch.object(seed, 'PROJECT_ROOT', self.repo)
        self.project_patch.start()
        self.addCleanup(self.project_patch.stop)
        self.hints = seed.HierarchyHints()

    def image(self, relative):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'image fixture')

    def test_full_families_preserve_numeric_model_and_url_encoding(self):
        for suffix in ('', ' 1', ' 2', ' 10'):
            self.image(f'Tablet/Infinix/Infinix Xpad 20{suffix}.png')
        self.image('Accessories/Headphone/A4TECH/A4tech BH235 #100%.jfif')
        records = seed.scan_local_images(self.root, self.hints)
        families = seed.group_local_records(records)
        family = families['infinix|infinix-xpad-20']
        self.assertEqual(len(family), 4)
        self.assertEqual(sorted(r.sequence for r in family), [0, 1, 2, 10])
        main = seed.choose_primary_record(family, 'Infinix')
        self.assertTrue(main.image.endswith('Infinix%20Xpad%2020.png'))
        self.assertFalse(any(r.review_reason for r in family))
        self.assertTrue(all(r.image.startswith('/Product_Images/') for r in records))
        special = next(r for r in records if r.image.endswith('.jfif'))
        self.assertIn('%23100%25', special.image)

    def test_missing_main_and_duplicate_indices_require_review(self):
        for suffix in (' 1', ' 2', ' 3'):
            self.image(f'Accessories/Headphone/A4TECH/BH235{suffix}.png')
        family = next(iter(seed.group_local_records(seed.scan_local_images(self.root, self.hints)).values()))
        self.assertEqual(seed.choose_primary_record(family, 'A4TECH').sequence, 1)
        self.assertTrue(all(r.review_reason for r in family))
        self.image('Accessories/Headphone/A4TECH/BH235 1.jpg')
        families = seed.group_local_records(seed.scan_local_images(self.root, self.hints))
        self.assertTrue(all('Duplicate' in r.review_reason for r in next(iter(families.values()))))

    def test_dry_run_needs_no_manifests_and_never_researches_or_writes(self):
        for suffix in ('', ' 1', ' 2'):
            self.image(f'Accessories/Headphone/A4TECH/BH235{suffix}.png')
        with patch('sys.argv', ['desiplus_full_seed.py', '--dry-run', '--limit', '1']), \
                patch.object(seed, 'StarTechClient', side_effect=AssertionError('network/cache')), \
                patch.object(seed, 'json_dump_atomic', side_effect=AssertionError('write')), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(seed.main(), 0)

    def test_known_product_has_gallery_stable_identity_equal_prices_and_saved_stock(self):
        for suffix in ('', ' 1', ' 2', ' 10'):
            self.image(f'Accessories/Headphone/A4TECH/BH235{suffix}.png')
        family = next(iter(seed.group_local_records(seed.scan_local_images(self.root, self.hints)).values()))
        product = {'name': 'A4TECH BH235 Headphone', 'model': 'BH235', 'brandName': 'A4TECH',
                   'basePrice': 0, 'available': True, 'variants': [{'price': 0, 'stock': 175}],
                   'sourceProductUrl': seed.BASE + '/bh235', 'stock': 175}
        args = Namespace(stock=None, assigned_stock=175, cost_ratio=0,
                         respect_source_availability=False, publish_priced=True, min_match_score=0.72)
        with patch.object(seed, 'resolve_product_page', return_value=(seed.BASE+'/bh235', object(), {})), \
                patch.object(seed, 'parse_product_page', side_effect=lambda *a, **kw: copy.deepcopy(product)) as parse:
            result = seed.scrape_group('bh235', family, None, args, self.hints)
        self.assertTrue(result['ok'])
        parsed = result['product']
        self.assertEqual(parse.call_args.kwargs['stock'], 175)
        self.assertEqual(len(parsed['gallery']), 3)
        self.assertTrue(parsed['gallery'][-1].endswith('BH235%2010.png'))
        self.assertFalse(parsed['available'])
        self.assertFalse(parsed['variants'][0]['active'])
        self.assertEqual(parsed['basePrice'], parsed['variants'][0]['price'])
        self.assertEqual(parsed['sku'], parsed['variants'][0]['sku'])
        self.assertLessEqual(len(parsed['slug']), 191)
        wrong = copy.deepcopy(product)
        wrong.update(name='A4TECH BH2350 Headphone', model='BH2350')
        with patch.object(seed, 'resolve_product_page', return_value=(seed.BASE+'/bh2350', object(), {})), \
                patch.object(seed, 'parse_product_page', return_value=wrong):
            self.assertFalse(seed.scrape_group('bh235', family, None, args, self.hints)['ok'])

    def test_unknown_price_does_not_use_historical_description_or_derive_cost(self):
        soup = seed.BeautifulSoup('<h1>A4TECH BH235 Headphone</h1><div id="description">'
                                  'The latest price of BH235 in Bangladesh is 999 ৳</div>', 'html.parser')
        product = seed.parse_product_page(soup, seed.BASE+'/bh235', 175, 0.96, False)
        self.assertEqual(product['basePrice'], 0)
        self.assertIsNone(product['variants'][0]['costPrice'])

    def test_generation_reuses_opening_quantity_and_limits_whole_family(self):
        for suffix in ('', ' 1', ' 2'):
            self.image(f'Accessories/Headphone/A4TECH/BH235{suffix}.png')
        output = self.repo / 'seed.json'
        soup = seed.BeautifulSoup('<h1>A4TECH BH235 Headphone</h1>', 'html.parser')
        command = ['desiplus_full_seed.py', '--limit', '1', '--output', str(output)]
        with patch.object(seed, 'StarTechClient'), \
                patch.object(seed, 'resolve_product_page', return_value=(seed.BASE+'/bh235', soup, {})), \
                contextlib.redirect_stdout(io.StringIO()):
            with patch('sys.argv', command):
                self.assertEqual(seed.main(), 0)
            first = json.loads(output.read_text(encoding='utf-8'))['products'][0]
            with patch('sys.argv', command + ['--stock', '500']):
                self.assertEqual(seed.main(), 0)
            second = json.loads(output.read_text(encoding='utf-8'))['products'][0]
        self.assertTrue(100 <= first['stock'] <= 500)
        self.assertEqual(first['stock'], second['stock'])
        self.assertEqual(second['stock'], second['variants'][0]['stock'])
        self.assertEqual(len(second['sourceImages']), 3)
        self.assertEqual(len(second['gallery']), 2)


if __name__ == '__main__':
    unittest.main()
