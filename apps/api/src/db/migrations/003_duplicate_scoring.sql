-- 003 · Better duplicate scoring for Arabic item names.
-- Light stemming (drops the definite article "ال" on longer words) + bidirectional word similarity,
-- so re-ordered or partially typed names ("ورق A4 تصوير" vs "ورق تصوير A4 80 جرام") still match.
CREATE OR REPLACE FUNCTION normalize_ar_stem(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(CASE WHEN length(w) > 4 AND w LIKE 'ال%' THEN substr(w, 3) ELSE w END, ' '), '')
    FROM regexp_split_to_table(normalize_ar(t), '\s+') w
$$;

CREATE OR REPLACE FUNCTION item_name_score(a text, b text) RETURNS real LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT greatest(
    similarity(normalize_ar_stem(a), normalize_ar_stem(b)),
    (word_similarity(normalize_ar(a), normalize_ar(b)) + word_similarity(normalize_ar(b), normalize_ar(a))) / 2)
$$;
