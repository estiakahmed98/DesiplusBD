import copy
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from scripts.python import reconcile_desiplus_seed_images as tool
from scripts.python import desiplus_full_seed as scanner


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name)
        self.images = self.repo / 'public/Product_Images'
        self.images.mkdir(parents=True)
        self.seeds = self.repo / 'prisma/Desi Plus Product Seed'
        self.catalog = self.seeds / 'accessories/_all.json'
        for module in (tool, scanner):
            name = 'PROJECT' if module is tool else 'PROJECT_ROOT'
            context = patch.object(module, name, self.repo)
            context.start()
            self.addCleanup(context.stop)

    def product(self, name, slug, sku):
        return {'name': name, 'slug': slug, 'sku': sku, 'categorySlug': 'headphones',
                'brandName': 'Brand', 'basePrice': 1234, 'stock': 17,
                'description': 'Verified existing description', 'image': '/old/' + slug + '.png',
                'gallery': [], 'sourceImages': [], 'variants': [{'sku': sku, 'price': 1234,
                    'stock': 17, 'active': False, 'options': {}, 'colorImage': None}]}

    def setup_catalog(self, products):
        data = {'categories': [{'slug': 'accessories', 'name': 'Accessories', 'parentSlug': None},
                               {'slug': 'headphones', 'name': 'Headphones', 'parentSlug': 'accessories'}],
                'brands': [{'name': 'Brand', 'slug': 'brand'}], 'products': products}
        tool.write(self.catalog, data)
        tool.write(self.seeds / 'index.json', {'groups': [{'file': 'accessories/_all.json', 'status': 'completed'}]})
        return data

    def image(self, filename):
        path = self.images / 'Accessories/Headphones/Brand' / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture')

    def test_complete_and_lone_numbered_images_preserve_model_number(self):
        self.setup_catalog([self.product('Brand Xpad 20', 'xpad-20', '20')])
        for name in ('Brand Xpad 20.png', 'Brand Xpad 20 2.png', 'Brand Xpad 20 10.png'):
            self.image(name)
        plan = tool.build_plan(self.seeds, self.images)
        media = next(iter(plan['media'].values()))
        self.assertTrue(media['image'].endswith('Xpad%2020.png'))
        self.assertTrue(media['gallery'][-1].endswith('20%2010.png'))
        self.assertEqual(plan['summary']['matchedImages'], 3)

    def test_plus_and_plain_models_do_not_merge(self):
        self.setup_catalog([self.product('Brand Pro', 'pro', 'A'), self.product('Brand Pro+', 'pro-plus', 'B')])
        self.image('Brand Pro.png')
        self.image('Brand Pro+.png')
        plan = tool.build_plan(self.seeds, self.images)
        self.assertEqual(len(plan['media']), 2)
        self.assertNotEqual(plan['media'][('pro', 'A')]['image'], plan['media'][('pro-plus', 'B')]['image'])

    def test_conflicting_skus_are_reported_not_guessed(self):
        self.setup_catalog([self.product('Brand Laptop', 'laptop-a', 'A'),
                            self.product('Brand Laptop', 'laptop-b', 'B')])
        self.image('Brand Laptop.png')
        plan = tool.build_plan(self.seeds, self.images)
        self.assertFalse(plan['media'])
        self.assertEqual(len(plan['ambiguous']), 1)

    def test_title_wins_over_stale_image_alias_and_lone_photo_matches(self):
        right = self.product('Brand BH235', 'bh235', 'A')
        wrong = self.product('Brand BH300', 'bh300', 'B')
        wrong['image'] = '/old/Brand BH235.png'
        self.setup_catalog([right, wrong])
        self.image('Brand BH235 4.png')
        plan = tool.build_plan(self.seeds, self.images)
        self.assertEqual(set(plan['media']), {('bh235', 'A')})

    def test_apply_backs_up_prunes_and_preserves_nonmedia_fields(self):
        product = self.product('Brand BH235', 'bh235', 'A')
        original = self.setup_catalog([product, self.product('Brand Other', 'other', 'B')])
        self.image('Brand BH235.png')
        self.image('Brand BH235 1.png')
        plan = tool.build_plan(self.seeds, self.images)
        result = tool.apply_plan(plan, self.seeds, self.images)
        after = tool.read(self.catalog)
        self.assertEqual(len(after['products']), 1)
        actual = after['products'][0]
        for field in ('sku', 'slug', 'description', 'basePrice', 'stock', 'variants'):
            self.assertEqual(product[field], actual[field])
        tool.validate_catalog(after, self.images)
        with zipfile.ZipFile(result['backup']) as backup:
            self.assertEqual(json.loads(backup.read('accessories/_all.json')), original)
        second = tool.build_plan(self.seeds, self.images)
        self.assertEqual(tool.reconcile_catalog(after, second['media']), after)


if __name__ == '__main__':
    unittest.main()
