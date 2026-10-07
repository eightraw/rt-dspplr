;; prepare's numeric kernels, WebAssembly SIMD (simd128), compiled by build/build-prepare-wasm.mjs.
;;
;; Two lanes of f64x2 carry two independent filter chains; each lane does the JS
;; code's arithmetic in the JS code's order (IEEE double, no fused multiply-add
;; in WebAssembly), so the bands are the same bytes as the scalar code's. The
;; lag sums of the alignment add pairs of samples per lane, so they differ from
;; a single running sum in the last bits; they only rank lags. The 16-bit conversions and the
;; peaks do the JS kernels' double arithmetic lane by lane too: the same bytes.

(module
  (memory (export "memory") 1)

  ;; Two biquad pairs in series, chain 0 in lane 0 and chain 1 in lane 1, over the doubles
  ;; d[0, m) (the same input in both lanes); each chain's second output squared into acc.
  ;;   coef  10 × v128: b0 b1 b2 a1 a2 (first section), d0 d1 d2 e1 e2 (second section)
  ;;   state  8 × v128: x1 x2 y1 y2 (first), u1 u2 v1 v2 (second)
  ;;   acc    1 × v128
  ;; Per sample, per lane: y = b0·x + b1·x1 + b2·x2 − a1·y1 − a2·y2;
  ;;                       v = d0·y + d1·u1 + d2·u2 − e1·v1 − e2·v2; acc += v·v.
  (func (export "cutoff_pair") (param $coef i32) (param $state i32) (param $d i32) (param $m i32) (param $acc i32)
    (local $b0 v128) (local $b1 v128) (local $b2 v128) (local $a1 v128) (local $a2 v128)
    (local $d0 v128) (local $d1 v128) (local $d2 v128) (local $e1 v128) (local $e2 v128)
    (local $x1 v128) (local $x2 v128) (local $y1 v128) (local $y2 v128)
    (local $u1 v128) (local $u2 v128) (local $v1 v128) (local $v2 v128)
    (local $s v128) (local $x v128) (local $y v128) (local $v v128)
    (local $p i32) (local $end i32)
    (local.set $b0 (v128.load offset=0 (local.get $coef)))
    (local.set $b1 (v128.load offset=16 (local.get $coef)))
    (local.set $b2 (v128.load offset=32 (local.get $coef)))
    (local.set $a1 (v128.load offset=48 (local.get $coef)))
    (local.set $a2 (v128.load offset=64 (local.get $coef)))
    (local.set $d0 (v128.load offset=80 (local.get $coef)))
    (local.set $d1 (v128.load offset=96 (local.get $coef)))
    (local.set $d2 (v128.load offset=112 (local.get $coef)))
    (local.set $e1 (v128.load offset=128 (local.get $coef)))
    (local.set $e2 (v128.load offset=144 (local.get $coef)))
    (local.set $x1 (v128.load offset=0 (local.get $state)))
    (local.set $x2 (v128.load offset=16 (local.get $state)))
    (local.set $y1 (v128.load offset=32 (local.get $state)))
    (local.set $y2 (v128.load offset=48 (local.get $state)))
    (local.set $u1 (v128.load offset=64 (local.get $state)))
    (local.set $u2 (v128.load offset=80 (local.get $state)))
    (local.set $v1 (v128.load offset=96 (local.get $state)))
    (local.set $v2 (v128.load offset=112 (local.get $state)))
    (local.set $s (v128.load (local.get $acc)))
    (local.set $p (local.get $d))
    (local.set $end (i32.add (local.get $d) (i32.shl (local.get $m) (i32.const 3))))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
        (local.set $x (v128.load64_splat (local.get $p)))
        (local.set $y
          (f64x2.sub
            (f64x2.sub
              (f64x2.add
                (f64x2.add (f64x2.mul (local.get $b0) (local.get $x)) (f64x2.mul (local.get $b1) (local.get $x1)))
                (f64x2.mul (local.get $b2) (local.get $x2)))
              (f64x2.mul (local.get $a1) (local.get $y1)))
            (f64x2.mul (local.get $a2) (local.get $y2))))
        (local.set $x2 (local.get $x1))
        (local.set $x1 (local.get $x))
        (local.set $y2 (local.get $y1))
        (local.set $y1 (local.get $y))
        (local.set $v
          (f64x2.sub
            (f64x2.sub
              (f64x2.add
                (f64x2.add (f64x2.mul (local.get $d0) (local.get $y)) (f64x2.mul (local.get $d1) (local.get $u1)))
                (f64x2.mul (local.get $d2) (local.get $u2)))
              (f64x2.mul (local.get $e1) (local.get $v1)))
            (f64x2.mul (local.get $e2) (local.get $v2))))
        (local.set $u2 (local.get $u1))
        (local.set $u1 (local.get $y))
        (local.set $v2 (local.get $v1))
        (local.set $v1 (local.get $v))
        (local.set $s (f64x2.add (local.get $s) (f64x2.mul (local.get $v) (local.get $v))))
        (local.set $p (i32.add (local.get $p) (i32.const 8)))
        (br $next)))
    (v128.store offset=0 (local.get $state) (local.get $x1))
    (v128.store offset=16 (local.get $state) (local.get $x2))
    (v128.store offset=32 (local.get $state) (local.get $y1))
    (v128.store offset=48 (local.get $state) (local.get $y2))
    (v128.store offset=64 (local.get $state) (local.get $u1))
    (v128.store offset=80 (local.get $state) (local.get $u2))
    (v128.store offset=96 (local.get $state) (local.get $v1))
    (v128.store offset=112 (local.get $state) (local.get $v2))
    (v128.store (local.get $acc) (local.get $s)))

  ;; The split of the bands analyser over x[from, to): the top chain (high-pass at the split)
  ;; in lane 0, its output squared into t; the pre chain (low-pass) in lane 1, its output into
  ;; dst[i]; and Σ x² into e. coef and state as cutoff_pair's (lane 0 top, lane 1 pre);
  ;; sums: e at +0, t at +8 (doubles).
  (func (export "split_bands") (param $coef i32) (param $state i32) (param $x i32) (param $dst i32) (param $from i32) (param $to i32) (param $sums i32)
    (local $b0 v128) (local $b1 v128) (local $b2 v128) (local $a1 v128) (local $a2 v128)
    (local $d0 v128) (local $d1 v128) (local $d2 v128) (local $e1 v128) (local $e2 v128)
    (local $x1 v128) (local $x2 v128) (local $y1 v128) (local $y2 v128)
    (local $u1 v128) (local $u2 v128) (local $v1 v128) (local $v2 v128)
    (local $s v128) (local $xs v128) (local $y v128) (local $v v128)
    (local $e f64) (local $xv f64)
    (local $p i32) (local $q i32) (local $end i32)
    (local.set $b0 (v128.load offset=0 (local.get $coef)))
    (local.set $b1 (v128.load offset=16 (local.get $coef)))
    (local.set $b2 (v128.load offset=32 (local.get $coef)))
    (local.set $a1 (v128.load offset=48 (local.get $coef)))
    (local.set $a2 (v128.load offset=64 (local.get $coef)))
    (local.set $d0 (v128.load offset=80 (local.get $coef)))
    (local.set $d1 (v128.load offset=96 (local.get $coef)))
    (local.set $d2 (v128.load offset=112 (local.get $coef)))
    (local.set $e1 (v128.load offset=128 (local.get $coef)))
    (local.set $e2 (v128.load offset=144 (local.get $coef)))
    (local.set $x1 (v128.load offset=0 (local.get $state)))
    (local.set $x2 (v128.load offset=16 (local.get $state)))
    (local.set $y1 (v128.load offset=32 (local.get $state)))
    (local.set $y2 (v128.load offset=48 (local.get $state)))
    (local.set $u1 (v128.load offset=64 (local.get $state)))
    (local.set $u2 (v128.load offset=80 (local.get $state)))
    (local.set $v1 (v128.load offset=96 (local.get $state)))
    (local.set $v2 (v128.load offset=112 (local.get $state)))
    (local.set $e (f64.load offset=0 (local.get $sums)))
    ;; t accumulates in lane 0 of s (lane 1 is unused).
    (local.set $s (f64x2.replace_lane 0 (f64x2.splat (f64.const 0)) (f64.load offset=8 (local.get $sums))))
    (local.set $p (i32.add (local.get $x) (i32.shl (local.get $from) (i32.const 3))))
    (local.set $q (i32.add (local.get $dst) (i32.shl (local.get $from) (i32.const 3))))
    (local.set $end (i32.add (local.get $x) (i32.shl (local.get $to) (i32.const 3))))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
        (local.set $xv (f64.load (local.get $p)))
        (local.set $e (f64.add (local.get $e) (f64.mul (local.get $xv) (local.get $xv))))
        (local.set $xs (f64x2.splat (local.get $xv)))
        (local.set $y
          (f64x2.sub
            (f64x2.sub
              (f64x2.add
                (f64x2.add (f64x2.mul (local.get $b0) (local.get $xs)) (f64x2.mul (local.get $b1) (local.get $x1)))
                (f64x2.mul (local.get $b2) (local.get $x2)))
              (f64x2.mul (local.get $a1) (local.get $y1)))
            (f64x2.mul (local.get $a2) (local.get $y2))))
        (local.set $x2 (local.get $x1))
        (local.set $x1 (local.get $xs))
        (local.set $y2 (local.get $y1))
        (local.set $y1 (local.get $y))
        (local.set $v
          (f64x2.sub
            (f64x2.sub
              (f64x2.add
                (f64x2.add (f64x2.mul (local.get $d0) (local.get $y)) (f64x2.mul (local.get $d1) (local.get $u1)))
                (f64x2.mul (local.get $d2) (local.get $u2)))
              (f64x2.mul (local.get $e1) (local.get $v1)))
            (f64x2.mul (local.get $e2) (local.get $v2))))
        (local.set $u2 (local.get $u1))
        (local.set $u1 (local.get $y))
        (local.set $v2 (local.get $v1))
        (local.set $v1 (local.get $v))
        (local.set $s (f64x2.add (local.get $s) (f64x2.mul (local.get $v) (local.get $v))))
        (f64.store (local.get $q) (f64x2.extract_lane 1 (local.get $v)))
        (local.set $p (i32.add (local.get $p) (i32.const 8)))
        (local.set $q (i32.add (local.get $q) (i32.const 8)))
        (br $next)))
    (v128.store offset=0 (local.get $state) (local.get $x1))
    (v128.store offset=16 (local.get $state) (local.get $x2))
    (v128.store offset=32 (local.get $state) (local.get $y1))
    (v128.store offset=48 (local.get $state) (local.get $y2))
    (v128.store offset=64 (local.get $state) (local.get $u1))
    (v128.store offset=80 (local.get $state) (local.get $u2))
    (v128.store offset=96 (local.get $state) (local.get $v1))
    (v128.store offset=112 (local.get $state) (local.get $v2))
    (f64.store offset=0 (local.get $sums) (local.get $e))
    (f64.store offset=8 (local.get $sums) (f64x2.extract_lane 0 (local.get $s))))

  ;; out[j] = Σ_i a[i]·b[i + k + j] for j = 0…3, a and b float32, the sums in double:
  ;; pairs of i in the two lanes, the lanes added at the end, an odd last i added after.
  (func (export "dot4") (param $a i32) (param $b i32) (param $w i32) (param $k i32) (param $out i32)
    (local $s0 v128) (local $s1 v128) (local $s2 v128) (local $s3 v128) (local $av v128)
    (local $pa i32) (local $pb i32) (local $end i32) (local $last f64) (local $tail i32)
    (local.set $pa (local.get $a))
    (local.set $pb (i32.add (local.get $b) (i32.shl (local.get $k) (i32.const 2))))
    (local.set $end (i32.add (local.get $a) (i32.shl (i32.and (local.get $w) (i32.const -2)) (i32.const 2))))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $pa) (local.get $end)))
        (local.set $av (f64x2.promote_low_f32x4 (v128.load64_zero (local.get $pa))))
        (local.set $s0 (f64x2.add (local.get $s0) (f64x2.mul (local.get $av) (f64x2.promote_low_f32x4 (v128.load64_zero offset=0 (local.get $pb))))))
        (local.set $s1 (f64x2.add (local.get $s1) (f64x2.mul (local.get $av) (f64x2.promote_low_f32x4 (v128.load64_zero offset=4 (local.get $pb))))))
        (local.set $s2 (f64x2.add (local.get $s2) (f64x2.mul (local.get $av) (f64x2.promote_low_f32x4 (v128.load64_zero offset=8 (local.get $pb))))))
        (local.set $s3 (f64x2.add (local.get $s3) (f64x2.mul (local.get $av) (f64x2.promote_low_f32x4 (v128.load64_zero offset=12 (local.get $pb))))))
        (local.set $pa (i32.add (local.get $pa) (i32.const 8)))
        (local.set $pb (i32.add (local.get $pb) (i32.const 8)))
        (br $next)))
    (local.set $tail (i32.and (local.get $w) (i32.const 1)))
    (local.set $last (select (f64.promote_f32 (f32.load (local.get $pa))) (f64.const 0) (local.get $tail)))
    (f64.store offset=0 (local.get $out)
      (f64.add (f64.add (f64x2.extract_lane 0 (local.get $s0)) (f64x2.extract_lane 1 (local.get $s0)))
        (select (f64.mul (local.get $last) (f64.promote_f32 (f32.load offset=0 (local.get $pb)))) (f64.const 0) (local.get $tail))))
    (f64.store offset=8 (local.get $out)
      (f64.add (f64.add (f64x2.extract_lane 0 (local.get $s1)) (f64x2.extract_lane 1 (local.get $s1)))
        (select (f64.mul (local.get $last) (f64.promote_f32 (f32.load offset=4 (local.get $pb)))) (f64.const 0) (local.get $tail))))
    (f64.store offset=16 (local.get $out)
      (f64.add (f64.add (f64x2.extract_lane 0 (local.get $s2)) (f64x2.extract_lane 1 (local.get $s2)))
        (select (f64.mul (local.get $last) (f64.promote_f32 (f32.load offset=8 (local.get $pb)))) (f64.const 0) (local.get $tail))))
    (f64.store offset=24 (local.get $out)
      (f64.add (f64.add (f64x2.extract_lane 0 (local.get $s3)) (f64x2.extract_lane 1 (local.get $s3)))
        (select (f64.mul (local.get $last) (f64.promote_f32 (f32.load offset=12 (local.get $pb)))) (f64.const 0) (local.get $tail)))))

  ;; ---- 16-bit samples and peaks: the JS kernels' arithmetic, lane by lane -------------------
  ;; Finite input only (prepare's samples are: the decoders' blocks pass finiteBlocks()).

  ;; Doubles y to integers as the JS kernels round them: r = ceil(y), v = r − (r − 0.5 > y)
  ;; (Math.round), clamped to [lo, 32767]; the two in lanes 0 and 1 of an i32x4 (2 and 3 zero).
  (func $round2 (param $y v128) (param $lo v128) (result v128)
    (local $r v128)
    (local.set $r (f64x2.ceil (local.get $y)))
    (i32x4.trunc_sat_f64x2_s_zero
      (f64x2.pmax (local.get $lo)
        (f64x2.pmin (f64x2.splat (f64.const 32767))
          (f64x2.sub (local.get $r)
            (v128.and
              (f64x2.gt (f64x2.sub (local.get $r) (f64x2.splat (f64.const 0.5))) (local.get $y))
              (f64x2.splat (f64.const 1))))))))

  ;; Four float32 times k (in double), rounded and clamped as $round2: four integers, an i32x4.
  (func $round4 (param $x v128) (param $k v128) (param $lo v128) (result v128)
    (i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
      (call $round2 (f64x2.mul (f64x2.promote_low_f32x4 (local.get $x)) (local.get $k)) (local.get $lo))
      (call $round2
        (f64x2.mul (f64x2.promote_low_f32x4 (i8x16.shuffle 8 9 10 11 12 13 14 15 8 9 10 11 12 13 14 15 (local.get $x) (local.get $x))) (local.get $k))
        (local.get $lo))))

  ;; toInt16Strided() for two channels, interleaved: dst[2i] = q(l[i]), dst[2i + 1] = q(r[i]) for
  ;; i < n, q(x) = Math.round(x · 32768) clamped to [−32768, 32767].
  (func (export "int16_stereo") (param $l i32) (param $r i32) (param $n i32) (param $dst i32)
    (local $i i32) (local $end i32) (local $k v128) (local $lo v128) (local $q v128) (local $at i32)
    (local.set $k (f64x2.splat (f64.const 32768)))
    (local.set $lo (f64x2.splat (f64.const -32768)))
    (local.set $end (i32.and (local.get $n) (i32.const -4)))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $end)))
        (local.set $at (i32.shl (local.get $i) (i32.const 2)))
        (local.set $q (i16x8.narrow_i32x4_s
          (call $round4 (v128.load (i32.add (local.get $l) (local.get $at))) (local.get $k) (local.get $lo))
          (call $round4 (v128.load (i32.add (local.get $r) (local.get $at))) (local.get $k) (local.get $lo))))
        (v128.store (i32.add (local.get $dst) (local.get $at))
          (i8x16.shuffle 0 1 8 9 2 3 10 11 4 5 12 13 6 7 14 15 (local.get $q) (local.get $q)))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $next)))
    ;; the last frames one by one: l in lane 0, r in lane 1
    (block $tail
      (loop $one
        (br_if $tail (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $at (i32.shl (local.get $i) (i32.const 2)))
        (local.set $q (call $round2
          (f64x2.mul
            (f64x2.replace_lane 1
              (f64x2.splat (f64.promote_f32 (f32.load (i32.add (local.get $l) (local.get $at)))))
              (f64.promote_f32 (f32.load (i32.add (local.get $r) (local.get $at)))))
            (local.get $k))
          (local.get $lo)))
        (i32.store16 offset=0 (i32.add (local.get $dst) (local.get $at)) (i32x4.extract_lane 0 (local.get $q)))
        (i32.store16 offset=2 (i32.add (local.get $dst) (local.get $at)) (i32x4.extract_lane 1 (local.get $q)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $one))))

  ;; toInt16Strided() for one channel: dst[i] = q(x[i]), i < n.
  (func (export "int16_mono") (param $x i32) (param $n i32) (param $dst i32)
    (local $i i32) (local $end i32) (local $k v128) (local $lo v128) (local $q v128)
    (local.set $k (f64x2.splat (f64.const 32768)))
    (local.set $lo (f64x2.splat (f64.const -32768)))
    (local.set $end (i32.and (local.get $n) (i32.const -4)))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $end)))
        (local.set $q (call $round4 (v128.load (i32.add (local.get $x) (i32.shl (local.get $i) (i32.const 2)))) (local.get $k) (local.get $lo)))
        (i64.store (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1)))
          (i64x2.extract_lane 0 (i16x8.narrow_i32x4_s (local.get $q) (local.get $q))))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $next)))
    (block $tail
      (loop $one
        (br_if $tail (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $q (call $round2
          (f64x2.mul (f64x2.splat (f64.promote_f32 (f32.load (i32.add (local.get $x) (i32.shl (local.get $i) (i32.const 2)))))) (local.get $k))
          (local.get $lo)))
        (i32.store16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (i32x4.extract_lane 0 (local.get $q)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $one))))

  ;; monoI16x2() of the spectrogram: dst[i] = Math.round((a[i] + b[i]) · scale) clamped to
  ;; [−32767, 32767], the sum and the product in double, i < n.
  (func (export "mono_i16_stereo") (param $a i32) (param $b i32) (param $n i32) (param $scale f64) (param $dst i32)
    (local $i i32) (local $end i32) (local $k v128) (local $lo v128) (local $va v128) (local $vb v128) (local $q v128) (local $at i32)
    (local.set $k (f64x2.splat (local.get $scale)))
    (local.set $lo (f64x2.splat (f64.const -32767)))
    (local.set $end (i32.and (local.get $n) (i32.const -4)))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $end)))
        (local.set $at (i32.shl (local.get $i) (i32.const 2)))
        (local.set $va (v128.load (i32.add (local.get $a) (local.get $at))))
        (local.set $vb (v128.load (i32.add (local.get $b) (local.get $at))))
        (local.set $q (i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
          (call $round2
            (f64x2.mul (f64x2.add (f64x2.promote_low_f32x4 (local.get $va)) (f64x2.promote_low_f32x4 (local.get $vb))) (local.get $k))
            (local.get $lo))
          (call $round2
            (f64x2.mul
              (f64x2.add
                (f64x2.promote_low_f32x4 (i8x16.shuffle 8 9 10 11 12 13 14 15 8 9 10 11 12 13 14 15 (local.get $va) (local.get $va)))
                (f64x2.promote_low_f32x4 (i8x16.shuffle 8 9 10 11 12 13 14 15 8 9 10 11 12 13 14 15 (local.get $vb) (local.get $vb))))
              (local.get $k))
            (local.get $lo))))
        (i64.store (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1)))
          (i64x2.extract_lane 0 (i16x8.narrow_i32x4_s (local.get $q) (local.get $q))))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $next)))
    (block $tail
      (loop $one
        (br_if $tail (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $at (i32.shl (local.get $i) (i32.const 2)))
        (local.set $q (call $round2
          (f64x2.mul
            (f64x2.splat (f64.add (f64.promote_f32 (f32.load (i32.add (local.get $a) (local.get $at)))) (f64.promote_f32 (f32.load (i32.add (local.get $b) (local.get $at))))))
            (local.get $k))
          (local.get $lo)))
        (i32.store16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (i32x4.extract_lane 0 (local.get $q)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $one))))

  ;; peakBins() for two channels at once, l in lane 0 and r in lane 1: per bin of fpp frames over
  ;; [0, n) the low (v < lo), the high (v > hi) and Σx² in the JS order; into out per bin as three
  ;; f64x2: lo, hi, Σx².
  (func (export "peaks_stereo") (param $l i32) (param $r i32) (param $n i32) (param $fpp i32) (param $out i32)
    (local $i i32) (local $to i32) (local $lo v128) (local $hi v128) (local $sq v128) (local $v v128) (local $at i32)
    (block $done
      (loop $bin
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $to (select (i32.add (local.get $i) (local.get $fpp)) (local.get $n)
          (i32.lt_u (i32.add (local.get $i) (local.get $fpp)) (local.get $n))))
        (local.set $lo (f64x2.splat (f64.const inf)))
        (local.set $hi (f64x2.splat (f64.const -inf)))
        (local.set $sq (f64x2.splat (f64.const 0)))
        (block $end
          (loop $one
            (br_if $end (i32.ge_u (local.get $i) (local.get $to)))
            (local.set $at (i32.shl (local.get $i) (i32.const 2)))
            (local.set $v (f64x2.replace_lane 1
              (f64x2.splat (f64.promote_f32 (f32.load (i32.add (local.get $l) (local.get $at)))))
              (f64.promote_f32 (f32.load (i32.add (local.get $r) (local.get $at))))))
            (local.set $lo (f64x2.pmin (local.get $lo) (local.get $v)))
            (local.set $hi (f64x2.pmax (local.get $hi) (local.get $v)))
            (local.set $sq (f64x2.add (local.get $sq) (f64x2.mul (local.get $v) (local.get $v))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $one)))
        (v128.store offset=0 (local.get $out) (local.get $lo))
        (v128.store offset=16 (local.get $out) (local.get $hi))
        (v128.store offset=32 (local.get $out) (local.get $sq))
        (local.set $out (i32.add (local.get $out) (i32.const 48)))
        (br $bin))))
)
