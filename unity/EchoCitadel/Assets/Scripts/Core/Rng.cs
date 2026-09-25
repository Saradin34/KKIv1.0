/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — детерминированный ГПСЧ.
   ---------------------------------------------------------------------
   Побитово точный порт Rng из src/engine/types.ts (32-битный xorshift
   с выходом ((s0 + s1) >>> 0) / 2^32).

   ВНИМАНИЕ. System.Random здесь использовать НЕЛЬЗЯ: его последователь-
   ность зависит от реализации .NET и не воспроизводится в JS. Совпадение
   последовательности TS ↔ C# — обязательное условие:
     • один и тот же seed даёт один и тот же матч в прототипе и в Unity;
     • отчёты баланса (docs/balance/*) можно перепроверять на C#;
     • реплеи и smoke-тесты переносимы между реализациями.
   Любое изменение формул ниже ломает сверку tools/csharp (-verify).

   Особенности семантики JS, которые обязан повторять порт:
     • (seed | 0)                → приведение к int32, 0 заменяется константой;
     • <<, >>>                   → знаковый сдвиг и БЕЗзнаковый сдвиг int32;
     • Math.floor(x * n)         → Int() (x всегда из [0,1), так что
                                   приведение к int совпадает с floor);
     • КРИТИЧНО: в конструкторе TS умножает В DOUBLE
           this.s1 = (this.s0 * 1812433253 + 12345) | 0;
       а не через Math.imul. При |seed| ≥ 11 930 465 произведение превышает
       2^53 и округляется, поэтому результат ОТЛИЧАЕТСЯ от честного int32:
           seed 20260903 → double-путь даёт s1 = 2038883992,
                           Math.imul/checked int32 дал бы 2038883996.
       Наш официальный seed баланса — 20260903, то есть «кривой» случай.
       Поэтому ниже используется ToInt32Js(double) — точная копия JS-оператора
       |0 (ToInt32: отбросить дробь, взять остаток по модулю 2^32, привести
       к знаковому). Обычное unchecked-умножение int тут НЕЛЬЗЯ: оно дало бы
       математически верный, но отличный от TS результат и сломало бы
       воспроизводимость официальных прогонов баланса.
   ===================================================================== */

using System.Collections.Generic;

namespace EchoCitadel.Core
{
    /// <summary>
    /// ГПСЧ игры. ПотокоНЕбезопасен — один экземпляр на матч, вызовы только
    /// из потока логики (в Unity: главный поток; вся симуляция синхронная).
    /// </summary>
    public sealed class Rng
    {
        private int _s0;
        private int _s1;

        /// <summary>Константа «золотого сечения» — замена вырожденного seed 0.</summary>
        private const int GoldenGamma = unchecked((int)0x9e3779b9);
        private const int FallbackS1 = unchecked((int)0x6d2b79f5);

        public Rng(int seed)
        {
            _s0 = seed != 0 ? seed : GoldenGamma;
            // JS: (this.s0 * 1812433253 + 12345) | 0  — умножение в double!
            _s1 = ToInt32Js(_s0 * 1812433253.0 + 12345.0);
            if (_s1 == 0) _s1 = FallbackS1;
        }

        /// <summary>
        /// Точная копия JS-оператора <c>|0</c> (ToInt32) для double:
        /// отбрасываем дробную часть, берём остаток по модулю 2^32,
        /// приводим к знаковому int32. В .NET приведение (int)double
        /// насыщается, поэтому считаем руками.
        /// </summary>
        internal static int ToInt32Js(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
            double t = System.Math.Truncate(v);
            t = System.Math.IEEERemainder(t, 4294967296.0);   // точное по модулю 2^32
            if (t < 0) t += 4294967296.0;
            return t >= 2147483648.0 ? (int)(t - 4294967296.0) : (int)t;
        }

        /// <summary>Текущее внутреннее состояние (для отладки/реплеев).</summary>
        public (int s0, int s1) State => (_s0, _s1);

        /// <summary>Следующее значение в [0, 1).</summary>
        public double Next()
        {
            int s1 = _s0;
            int s0 = _s1;
            _s0 = s0;
            unchecked
            {
                s1 ^= s1 << 23;          // JS: s1 ^= (s1 << 23) | 0
                s1 ^= (int)((uint)s1 >> 17);   // JS: s1 >>> 17 (беззнаковый)
                s1 ^= s0;
                s1 ^= (int)((uint)s0 >> 26);   // JS: s0 >>> 26 (беззнаковый)
            }
            _s1 = s1;
            return (uint)(_s0 + _s1) / 4294967296.0;   // JS: ((s0 + s1) >>> 0) / 2^32
        }

        /// <summary>Целое в [0, maxExclusive).</summary>
        public int Int(int maxExclusive) => (int)(Next() * maxExclusive);

        /// <summary>Целое в [min, max] включительно.</summary>
        public int Range(int min, int max) => min + Int(max - min + 1);

        /// <summary>Случайный элемент списка (пустой список → default).</summary>
        public T Pick<T>(IList<T> arr) => arr.Count == 0 ? default! : arr[Int(arr.Count)];

        /// <summary>
        /// Перемешивание Фишера–Йетса (обход с конца). Возвращает НОВЫЙ список:
        /// исходный не меняется — так же, как arr.slice() в TS.
        /// </summary>
        public List<T> Shuffle<T>(IReadOnlyList<T> arr)
        {
            var a = new List<T>(arr);
            for (int i = a.Count - 1; i > 0; i--)
            {
                int j = Int(i + 1);
                (a[i], a[j]) = (a[j], a[i]);
            }
            return a;
        }

        /// <summary>Событие с вероятностью p.</summary>
        public bool Chance(double p) => Next() < p;
    }

    /// <summary>
    /// Вероятностное округление (engine.ts → pround).
    /// Делает силу пассивки НЕПРЕРЫВНОЙ функцией множителя: 2.5 → 50% шанс 3,
    /// 50% шанс 2. Без этого балансировщик осциллирует между целыми ступенями.
    /// </summary>
    public static class ProbabilisticRound
    {
        public static int Round(Rng rng, double x)
        {
            if (x <= 0) return 0;
            int f = (int)System.Math.Floor(x);
            double frac = x - f;
            return rng.Next() < frac ? f + 1 : f;
        }
    }
}
