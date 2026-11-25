-- Terminology: «الرجيع» replaces «المرتجعات», and count/transfer variances are «فروقات» (no separate adjustments screen).
UPDATE movement_gl_map SET description_ar = 'رجيع للمستودع' WHERE movement_type = 'RTW';
UPDATE movement_gl_map SET description_ar = 'فروقات بالزيادة', description_en = 'Variance gain' WHERE movement_type = 'ADJ_PLUS';
UPDATE movement_gl_map SET description_ar = 'فروقات بالعجز', description_en = 'Variance loss' WHERE movement_type = 'ADJ_MINUS';
