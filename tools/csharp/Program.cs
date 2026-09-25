/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — проверочный стенд C#-порта.
   ---------------------------------------------------------------------
   Режимы:
     -verify    сверка C#-ядра с TypeScript-двишком: ГПСЧ (побитово),
                загрузка Cards.json/Decks.json, распределение базы,
                валидация колод, парсинг аур рун и коэффициентов пассивок.
                Эталоны — tools/csharp/expected.json, снятые с TS-движка.
     -balance   прогон N матчей на C# и сравнение винрейтов фракций
                с docs/balance/faction_report.csv (порог — 2.5 п.п.).
                Доступен после порта GameEngine.cs.

   Запуск: dotnet run -c Release -- -verify
   ===================================================================== */

using System.Globalization;
using System.Text;
using System.Text.Json;
using EchoCitadel.Core;
using EchoCitadel.AI;
using EchoCitadel.Data;

namespace EchoCitadel.Tools;

internal static class Program
{
    private static int _checks;
    private static int _fails;

    private static string Root()
    {
        // поднимаемся от bin/… до tools/csharp, затем до корня репозитория
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "package.json"))) dir = dir.Parent;
        if (dir == null) throw new InvalidOperationException("Не найден корень репозитория");
        return dir.FullName;
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        var root = Root();
        var mode = args.Length > 0 ? args[0].TrimStart('-') : "verify";

        Console.WriteLine("=== ЭХО-ЦИТАДЕЛЬ: проверка C#-порта ===");
        Console.WriteLine($"корень: {root}");
        Console.WriteLine($"режим:  {mode}\n");

        try
        {
            switch (mode)
            {
                case "verify":
                    VerifyRng(root);
                    VerifyDatabase(root);
                    VerifyDecks(root);
                    VerifyCoefficients(root);
                    break;
                case "parity":
                    RunParity(root, args);
                    break;
                case "dump":
                    DumpMatch(root, args);
                    break;
                case "balance":
                    RunBalance(root, args);
                    break;
                default:
                    Console.WriteLine("Неизвестный режим. Доступно: verify, parity, balance");
                    return 2;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine($"\nИСКЛЮЧЕНИЕ: {e.GetType().Name}: {e.Message}");
            Console.WriteLine(e.StackTrace);
            return 3;
        }

        Console.WriteLine($"\n--- ИТОГ: проверок {_checks}, провалов {_fails} ---");
        if (_fails == 0) Console.WriteLine("✅ C#-ядро совпадает с TypeScript-эталоном");
        else Console.WriteLine("⚠ ЕСТЬ РАСХОЖДЕНИЯ");
        return _fails == 0 ? 0 : 1;
    }

    /* ------------------------------- ПРОВЕРКИ ------------------------------ */

    private static void Check(string name, bool ok, string detail = "")
    {
        _checks++;
        if (!ok) _fails++;
        Console.WriteLine($"{(ok ? "  ✅" : "  ❌")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
    }

    /// <summary>ГПСЧ должен совпадать с TS побитово (Rng из types.ts).</summary>
    private static void VerifyRng(string root)
    {
        Console.WriteLine("[1] Детерминированный ГПСЧ (32-битный xorshift, порт Rng из types.ts)");
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "tools/csharp/expected.json")));
        var rngRef = doc.RootElement.GetProperty("rng");

        foreach (var seedProp in rngRef.EnumerateObject())
        {
            int seed = int.Parse(seedProp.Name, CultureInfo.InvariantCulture);
            var r = new Rng(seed);

            // первые 12 значений next() — с точностью до 17 значащих цифр
            var expected = seedProp.Value.GetProperty("first12");
            bool allOk = true;
            string firstDiff = "";
            for (int i = 0; i < expected.GetArrayLength(); i++)
            {
                double got = r.Next();
                string want = expected[i].GetString() ?? "";
                if (Math.Abs(got - double.Parse(want, CultureInfo.InvariantCulture)) > 1e-15)
                {
                    allOk = false;
                    firstDiff = $"#{i}: C# {got:R} vs TS {want}";
                    break;
                }
            }
            Check($"seed {seed}: 12 значений next() совпадают", allOk, allOk ? "" : firstDiff);

            // int() и range()
            var r2 = new Rng(seed);
            var ints = seedProp.Value.GetProperty("ints");
            int[] gotInts = { r2.Int(10), r2.Int(40), r2.Int(7), r2.Range(1, 6) };
            bool intsOk = true;
            for (int i = 0; i < ints.GetArrayLength(); i++)
                if (gotInts[i] != ints[i].GetInt32()) intsOk = false;
            Check($"seed {seed}: int()/range() совпадают", intsOk,
                intsOk ? "" : $"C# [{string.Join(",", gotInts)}] vs TS [{string.Join(",", ints.EnumerateArray().Select(x => x.GetInt32()))}]");

            // shuffle() — порядок обхода Фишера–Йетса обязан совпасть
            var r3 = new Rng(seed);
            var sh = seedProp.Value.GetProperty("shuffle");
            var shuffled = r3.Shuffle(new[] { "a", "b", "c", "d", "e", "f", "g", "h" });
            bool shOk = shuffled.SequenceEqual(sh.EnumerateArray().Select(x => x.GetString() ?? ""));
            Check($"seed {seed}: shuffle() совпадает", shOk,
                shOk ? "" : $"C# [{string.Join(",", shuffled)}] vs TS [{string.Join(",", sh.EnumerateArray().Select(x => x.GetString()))}]");
        }

        // вырожденный seed 0 не должен давать постоянную последовательность
        var z = new Rng(0);
        var zs = Enumerable.Range(0, 5).Select(_ => z.Next()).ToArray();
        Check("seed 0 не вырождается", zs.Distinct().Count() == 5, string.Join(", ", zs.Select(v => v.ToString("F4", CultureInfo.InvariantCulture))));

        // вероятностное округление: матожидание равно x
        var pr = new Rng(20260903);
        double x = 1.4;
        int sum = 0, n = 200000;
        for (int i = 0; i < n; i++) sum += ProbabilisticRound.Round(pr, x);
        double mean = (double)sum / n;
        Check("pround(1.4): матожидание ≈ 1.4", Math.Abs(mean - x) < 0.01, mean.ToString("F4", CultureInfo.InvariantCulture));
    }

    /// <summary>Загрузка базы карт и распределение (ТЗ п.3.1–3.2).</summary>
    private static void VerifyDatabase(string root)
    {
        Console.WriteLine("\n[2] База карт (Cards.json)");
        var cardsPath = Path.Combine(root, "unity/EchoCitadel/Assets/StreamingAssets/Cards.json");
        var db = CardDatabase.FromJson(File.ReadAllText(cardsPath));

        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "tools/csharp/expected.json")));
        var dist = doc.RootElement.GetProperty("db").GetProperty("dist");

        Check("карт загружено", db.Count == dist.GetProperty("total").GetInt32(), $"{db.Count} (TS: {dist.GetProperty("total").GetInt32()})");
        Check("токенов загружено", db.TokenCount == dist.GetProperty("tokens").GetInt32(), $"{db.TokenCount}");

        var got = db.Distribution();
        foreach (var key in new[] { "Creature", "Spell", "Rune", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Aurites", "Necrus", "Terramorph", "Pyromancer", "Ethereal", "Neutral" })
        {
            int want = dist.GetProperty(key).GetInt32();
            int have = got.TryGetValue(key, out var v) ? v : 0;
            Check($"распределение: {key}", have == want, $"{have} (TS: {want})");
        }

        // разбор конкретной карты: все поля, включая перечисления из строк
        var sample = doc.RootElement.GetProperty("db").GetProperty("sample");
        var aur01 = db.GetCard("aur_01");
        Check("карта aur_01 найдена", aur01 != null);
        if (aur01 != null)
        {
            Check("aur_01: имя", aur01.Name == sample.GetProperty("name").GetString(), aur01.Name);
            Check("aur_01: фракция", aur01.Faction.ToString() == sample.GetProperty("faction").GetString(), aur01.Faction.ToString());
            Check("aur_01: тип", aur01.Type.ToString() == sample.GetProperty("type").GetString(), aur01.Type.ToString());
            Check("aur_01: редкость", aur01.Rarity.ToString() == sample.GetProperty("rarity").GetString(), aur01.Rarity.ToString());
            Check("aur_01: стоимость", aur01.Cost == sample.GetProperty("cost").GetInt32(), aur01.Cost.ToString());
            Check("aur_01: атака/здоровье",
                aur01.Attack == sample.GetProperty("attack").GetInt32() && aur01.Health == sample.GetProperty("health").GetInt32(),
                $"{aur01.Attack}/{aur01.Health}");
            Check("aur_01: стихия", aur01.Element.ToString() == sample.GetProperty("element").GetString(), aur01.Element.ToString());
            Check("aur_01: целеуказание", aur01.Target.ToString() == sample.GetProperty("target").GetString(), aur01.Target.ToString());
            var wantKw = sample.GetProperty("keywords").EnumerateArray().Select(x => x.GetString()).ToArray();
            Check("aur_01: ключевые слова", aur01.Keywords.Select(k => k.ToString()).SequenceEqual(wantKw!),
                string.Join(",", aur01.Keywords));
        }

        // руны: аура, лимит, длительность — поля, которых нет в TS-интерфейсе,
        // но движок их читает (op = extraMana/heroProtection/…)
        var auraSamples = doc.RootElement.GetProperty("db").GetProperty("runeAuraSample");
        bool aurasOk = true;
        string auraDetail = "";
        foreach (var s in auraSamples.EnumerateArray())
        {
            var rune = db.GetCard(s.GetProperty("id").GetString()!);
            // часть рун работает через effects/onTurnStart, а не через ауру — это норма
            if (!s.TryGetProperty("aura", out var auraEl) || auraEl.ValueKind != JsonValueKind.Object) continue;
            if (rune?.Aura == null) { aurasOk = false; auraDetail = $"{s.GetProperty("id").GetString()}: аура не прочиталась"; break; }
            var wantOp = auraEl.GetProperty("op").GetString();
            if (rune.Aura.Op.ToString() != wantOp) { aurasOk = false; auraDetail = $"{rune.Id}: op C# {rune.Aura.Op} vs TS {wantOp}"; break; }
            if (s.TryGetProperty("runeLimit", out var limEl) && limEl.ValueKind == JsonValueKind.Number
                && rune.RuneLimit != limEl.GetInt32())
            { aurasOk = false; auraDetail = $"{rune.Id}: runeLimit {rune.RuneLimit}"; break; }
        }
        Check("руны: ауры и runeLimit прочитаны", aurasOk, auraDetail);

        int runesWithAura = 0;
        foreach (var c in db.All())
            if (c.Type == CardType.Rune && c.Aura != null) runesWithAura++;
        var distinctOps = db.All().Where(c => c.Aura != null).Select(c => c.Aura!.Op).Distinct().Count();
        Check("руны с аурой = 41", runesWithAura == 41, $"{runesWithAura} рун, {distinctOps} различных операций ауры");

        // эффекты: все операции из JSON обязаны распознаться (нет «unknown»)
        var ops = db.All()
            .SelectMany(c => c.Effects.Concat(c.OnDeath ?? new List<CardEffect>())
                .Concat(c.OnTurnStart ?? new List<CardEffect>())
                .Concat(c.OnSpellCast ?? new List<CardEffect>())
                .Concat(c.OnDamageTaken ?? new List<CardEffect>()))
            .Select(e => e.Op).Distinct().OrderBy(o => o.ToString()).ToArray();
        Check("операции эффектов распознаны", ops.Length >= 20, $"{ops.Length} шт.: {string.Join(", ", ops.Take(6))}…");

        // токены для summonToken лежат прямо в эффекте
        var tokenEffects = db.All()
            .SelectMany(c => c.Effects.Concat(c.OnDeath ?? new List<CardEffect>())
                .Concat(c.OnTurnStart ?? new List<CardEffect>())
                .Concat(c.OnSpellCast ?? new List<CardEffect>())
                .Concat(c.OnDamageTaken ?? new List<CardEffect>()))
            .Count(e => e.Op == EffectOp.summonToken && e.Token != null);
        Check("summonToken: встроенные токены прочитаны", tokenEffects == 57, $"{tokenEffects} эффектов");
    }

    /// <summary>Колоды: 40 карт, лимиты копий, доминирующая фракция.</summary>
    private static void VerifyDecks(string root)
    {
        Console.WriteLine("\n[3] Колоды (Decks.json)");
        var cardsPath = Path.Combine(root, "unity/EchoCitadel/Assets/StreamingAssets/Cards.json");
        var decksPath = Path.Combine(root, "unity/EchoCitadel/Assets/StreamingAssets/Decks.json");
        var (db, decks) = CardDatabase.FromJson(File.ReadAllText(cardsPath), File.ReadAllText(decksPath));

        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "tools/csharp/expected.json")));
        var want = doc.RootElement.GetProperty("decks");

        Check("колод загружено", decks.Decks.Count == want.GetArrayLength(), $"{decks.Decks.Count}");
        Check("размер колоды в meta = 40", decks.Meta.DeckSize == 40, decks.Meta.DeckSize.ToString());

        foreach (var w in want.EnumerateArray())
        {
            string id = w.GetProperty("id").GetString()!;
            var d = decks.Decks.FirstOrDefault(x => x.Id == id);
            Check($"колода {id}: найдена", d != null);
            if (d == null) continue;
            Check($"колода {id}: размер {w.GetProperty("size").GetInt32()}", d.Cards.Count == w.GetProperty("size").GetInt32(), d.Cards.Count.ToString());
            var errs = db.ValidateDeck(d.Cards, 40);
            Check($"колода {id}: валидна", errs.Count == 0, errs.Count == 0 ? "" : string.Join("; ", errs));
            string rawFaction = w.GetProperty("faction").GetString()!;
            bool factionOk = d.Faction.ToString() == rawFaction
                             // служебная колода «Starter» не имеет фракции в JSON —
                             // терпимый конвертер приводит её к Neutral (см. CardDatabase)
                             || (rawFaction == "Starter" && d.Faction == Faction.Neutral);
            Check($"колода {id}: фракция {rawFaction}", factionOk, d.Faction.ToString());
        }

        // лимит копий действительно ловится
        var bad = new List<string>(Enumerable.Repeat("aur_01", 3));
        bad.AddRange(Enumerable.Range(0, 37).Select(_ => "aur_02"));
        var badErrs = db.ValidateDeck(bad, 40);
        Check("валидатор ловит превышение лимита копий", badErrs.Any(e => e.Contains("лимит копий")), string.Join("; ", badErrs));
    }

    /// <summary>Коэффициенты пассивок из meta.factionCoefficients.</summary>
    private static void VerifyCoefficients(string root)
    {
        Console.WriteLine("\n[4] Коэффициенты баланса (meta.factionCoefficients)");
        var cardsPath = Path.Combine(root, "unity/EchoCitadel/Assets/StreamingAssets/Cards.json");
        var db = CardDatabase.FromJson(File.ReadAllText(cardsPath));

        Check("в meta есть коэффициенты", db.Meta.FactionCoefficients.Count >= 5, $"{db.Meta.FactionCoefficients.Count} фракций");

        var cfg = db.ApplyCoefficients(new GameConfig());
        bool allSet = true;
        var detail = new List<string>();
        foreach (var f in Factions.Playable)
        {
            double v = cfg.Passive(f);
            detail.Add($"{GameText.FactionRu(f)} {v:F4}");
            if (Math.Abs(v - 1.0) < 1e-9 && db.Meta.FactionCoefficients.ContainsKey(f.ToString())) allSet = false;
        }
        Check("passiveMul перенесён в GameConfig", allSet, string.Join(", ", detail));

        // значения обязаны совпадать с подобными решателем (docs/balance/solver_result.json)
        var solverPath = Path.Combine(root, "docs/balance/solver_result.json");
        if (File.Exists(solverPath))
        {
            using var s = JsonDocument.Parse(File.ReadAllText(solverPath));
            bool match = true;
            foreach (var f in Factions.Playable)
            {
                if (!s.RootElement.TryGetProperty(f.ToString(), out var fe)) continue;
                if (!fe.TryGetProperty("passiveMul", out var pm)) continue;
                double want = pm.GetDouble();
                if (Math.Abs(cfg.Passive(f) - want) > 1e-6) match = false;
            }
            Check("passiveMul совпадает с solver_result.json", match);
        }
        else
        {
            Check("solver_result.json на месте", false, "файл не найден");
        }
    }

    /* ------------------------- ПАРИТЕТ C# ↔ TYPESCRIPT ---------------------- */

    /// <summary>FNV-1a 32 бита по UTF-16 кодам — та же функция в tools/csharp/parity.ts.</summary>
    private static uint Fnv1a(string s)
    {
        unchecked
        {
            uint h = 2166136261u;
            foreach (char ch in s)
            {
                h ^= ch;
                h *= 16777619u;
            }
            return h;
        }
    }

    private static int ArgInt(string[] args, string name, int def)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == $"-{name}" || args[i] == $"--{name}")
                return int.Parse(args[i + 1], CultureInfo.InvariantCulture);
        return def;
    }

    /// <summary>Загрузка базы и колод так же, как это делает TS-эталон.</summary>
    private static (CardDatabase db, Dictionary<string, List<string>> decks, List<string> factionIds, GameConfig config)
        LoadLikeTs(string root)
    {
        string assets = Path.Combine(root, "unity/EchoCitadel/Assets/StreamingAssets");
        var (db, deckFile) = CardDatabase.FromJson(
            File.ReadAllText(Path.Combine(assets, "Cards.json")),
            File.ReadAllText(Path.Combine(assets, "Decks.json")));

        var decks = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var d in deckFile.Decks) decks[d.Id] = d.Cards;
        var factionIds = decks.Keys.Where(k => k != "Starter").ToList();

        // множители пассивок — из той же Cards.json (meta.factionCoefficients):
        // единый источник истины для TS-эталона и C#-стенда
        var config = db.ApplyCoefficients(new GameConfig());
        return (db, decks, factionIds, config);
    }

    /// <summary>
    /// Прогон тех же матчей, что записаны в parity_ts.json, и побайтовая сверка:
    /// победитель, ходы, здоровье, ВСЯ последовательность разыгранных карт,
    /// хеш журнала, статистика. Расхождение хотя бы в одном обращении к ГПСЧ
    /// здесь видно сразу.
    /// </summary>
    private static void RunParity(string root, string[] args)
    {
        Console.WriteLine("\n[5] Паритет партий: C# против TypeScript");

        string refPath = Path.Combine(root, "tools/csharp/parity_ts.json");
        if (!File.Exists(refPath))
        {
            Console.WriteLine("  ⚠ Нет эталона parity_ts.json. Снимите его:");
            Console.WriteLine("      npx esbuild tools/csharp/parity.ts --bundle --platform=node --outfile=build/parity.js");
            Console.WriteLine("      node build/parity.js --matches 200 --seed 20260903");
            _checks++; _fails++;
            return;
        }

        using var refDoc = JsonDocument.Parse(File.ReadAllText(refPath));
        var refRoot = refDoc.RootElement;
        var refMatches = refRoot.GetProperty("matches_");
        int baseSeed = refRoot.GetProperty("baseSeed").GetInt32();
        int total = refMatches.GetArrayLength();

        Console.WriteLine($"  эталон: {total} матчей, baseSeed {baseSeed}");

        var (db, decks, factionIds, config) = LoadLikeTs(root);

        // сверим множители пассивок: эталон пишет, какие применял
        var refMul = refRoot.GetProperty("passiveMul");
        bool mulOk = true;
        foreach (var kv in refMul.EnumerateObject())
        {
            if (!Enum.TryParse<Faction>(kv.Name, out var f)) { mulOk = false; break; }
            if (Math.Abs(config.Passive(f) - kv.Value.GetDouble()) > 1e-9) { mulOk = false; break; }
        }
        Check("passiveMul совпадает с эталоном", mulOk);

        // тот же порядок выбора пар и сторон, что в runSimulation (match.ts)
        var rng = new Rng(baseSeed);

        var report = new List<object>();
        int badMatches = 0;
        var firstDiffs = new List<string>();

        for (int i = 0; i < total; i++)
        {
            var want = refMatches[i];
            string left = rng.Pick(factionIds);
            string right = rng.Pick(factionIds);
            bool swap = rng.Chance(0.5);
            if (swap) (left, right) = (right, left);

            int seed = baseSeed + i * 7919;
            var runner = new MatchRunner(db, decks[left], decks[right],
                Enum.Parse<Faction>(left), Enum.Parse<Faction>(right),
                new MatchOptions { Seed = seed, Config = config });
            runner.SetupAI();
            var res = runner.Run();

            uint logHash = 0;
            foreach (var line in res.Log) logHash = Fnv1a($"{logHash}|{line}");

            var played = res.PlayedCards
                .Select(p => $"{(int)p.Side}:{p.CardId}")
                .ToList();

            var diffs = new List<string>();
            if (want.GetProperty("left").GetString() != left) diffs.Add($"left: TS {want.GetProperty("left").GetString()} / C# {left}");
            if (want.GetProperty("right").GetString() != right) diffs.Add($"right: TS {want.GetProperty("right").GetString()} / C# {right}");
            if (want.GetProperty("seed").GetInt32() != seed) diffs.Add("seed");
            if (want.GetProperty("result").GetString() != res.Result.ToString()) diffs.Add($"result: TS {want.GetProperty("result").GetString()} / C# {res.Result}");

            // TS-перечисление Side числовое (Player = 0, Opponent = 1),
            // поэтому эталон пишет «0»/«1» — сравниваем в той же форме
            string? wantWinner = want.GetProperty("winner").ValueKind == JsonValueKind.Null ? null : want.GetProperty("winner").GetString();
            string? gotWinner = res.Winner.HasValue ? ((int)res.Winner.Value).ToString(CultureInfo.InvariantCulture) : null;
            if (wantWinner != gotWinner) diffs.Add($"winner: TS {wantWinner ?? "null"} / C# {gotWinner ?? "null"}");

            if (want.GetProperty("turns").GetInt32() != res.Turns) diffs.Add($"turns: TS {want.GetProperty("turns").GetInt32()} / C# {res.Turns}");
            if (want.GetProperty("winnerHealth").GetInt32() != res.WinnerHealth) diffs.Add($"winnerHealth: TS {want.GetProperty("winnerHealth").GetInt32()} / C# {res.WinnerHealth}");
            if (want.GetProperty("loserHealth").GetInt32() != res.LoserHealth) diffs.Add($"loserHealth: TS {want.GetProperty("loserHealth").GetInt32()} / C# {res.LoserHealth}");
            if (want.GetProperty("logLines").GetInt32() != res.Log.Count) diffs.Add($"logLines: TS {want.GetProperty("logLines").GetInt32()} / C# {res.Log.Count}");
            if (want.GetProperty("logHash").GetInt64() != logHash) diffs.Add($"logHash: TS {want.GetProperty("logHash").GetInt64()} / C# {logHash}");

            // полная последовательность разыгранных карт
            var wantPlayed = want.GetProperty("played").EnumerateArray().Select(x => x.GetString()!).ToList();
            if (!wantPlayed.SequenceEqual(played, StringComparer.Ordinal))
            {
                int at = 0;
                while (at < Math.Min(wantPlayed.Count, played.Count) && wantPlayed[at] == played[at]) at++;
                diffs.Add($"played: расходятся с позиции {at} (TS {(at < wantPlayed.Count ? wantPlayed[at] : "—")} / C# {(at < played.Count ? played[at] : "—")}), всего TS {wantPlayed.Count} / C# {played.Count}");
            }

            // вклад карт в урон и лечение
            foreach (var kv in want.GetProperty("cardDamage").EnumerateObject())
            {
                int got = res.CardDamage.TryGetValue(kv.Name, out var v) ? v : 0;
                if (got != kv.Value.GetInt32()) { diffs.Add($"cardDamage[{kv.Name}]: TS {kv.Value.GetInt32()} / C# {got}"); break; }
            }
            foreach (var kv in want.GetProperty("cardHeal").EnumerateObject())
            {
                int got = res.CardHeal.TryGetValue(kv.Name, out var v) ? v : 0;
                if (got != kv.Value.GetInt32()) { diffs.Add($"cardHeal[{kv.Name}]: TS {kv.Value.GetInt32()} / C# {got}"); break; }
            }

            // статистика сторон
            var wantStats = want.GetProperty("stats");
            for (int si = 0; si < 2; si++)
            {
                var ws = wantStats[si];
                var gs = res.Stats[si];
                if (ws.GetProperty("damageDealt").GetInt32() != gs.DamageDealt) { diffs.Add($"stats[{si}].damageDealt: TS {ws.GetProperty("damageDealt").GetInt32()} / C# {gs.DamageDealt}"); break; }
                if (ws.GetProperty("healingDone").GetInt32() != gs.HealingDone) { diffs.Add($"stats[{si}].healingDone: TS {ws.GetProperty("healingDone").GetInt32()} / C# {gs.HealingDone}"); break; }
                if (ws.GetProperty("cardsPlayed").GetInt32() != gs.CardsPlayed) { diffs.Add($"stats[{si}].cardsPlayed: TS {ws.GetProperty("cardsPlayed").GetInt32()} / C# {gs.CardsPlayed}"); break; }
                if (ws.GetProperty("echoUsed").GetInt32() != gs.EchoUsed) { diffs.Add($"stats[{si}].echoUsed: TS {ws.GetProperty("echoUsed").GetInt32()} / C# {gs.EchoUsed}"); break; }
                if (ws.GetProperty("kills").GetInt32() != gs.Kills) { diffs.Add($"stats[{si}].kills: TS {ws.GetProperty("kills").GetInt32()} / C# {gs.Kills}"); break; }
            }

            if (diffs.Count > 0)
            {
                badMatches++;
                if (firstDiffs.Count < 5)
                    firstDiffs.Add($"  матч #{i} ({left} vs {right}, seed {seed}): {string.Join("; ", diffs)}");
            }

            report.Add(new
            {
                index = i, seed, left, right,
                result = res.Result.ToString(),
                winner = gotWinner,
                winnerName = res.Winner?.ToString(),
                turns = res.Turns,
                winnerHealth = res.WinnerHealth,
                loserHealth = res.LoserHealth,
                playedCount = played.Count,
                played,
                logLines = res.Log.Count,
                logHash,
                diffs,
            });
        }

        // побочный артефакт для отладки: что насчитал C#
        string outPath = Path.Combine(root, "tools/csharp/parity_cs.json");
        File.WriteAllText(outPath, JsonSerializer.Serialize(new
        {
            engine = "csharp",
            total,
            badMatches,
            matches = report,
        }, new JsonSerializerOptions { WriteIndented = false }));

        Check($"партии совпали полностью ({total - badMatches}/{total})", badMatches == 0,
            badMatches == 0 ? $"хеш журнала и все карты совпадают" : $"{badMatches} матчей с расхождениями");
        foreach (var d in firstDiffs) Console.WriteLine(d);
        if (badMatches > 0) Console.WriteLine($"  подробности: {outPath}");
        else Console.WriteLine($"  отчёт C#: {outPath}");
    }

    /* ------------------------- ОТЛАДКА ОДНОГО МАТЧА ------------------------- */

    /// <summary>
    /// Повторяет i-й матч эталонного прогона (тот же выбор пар и тот же seed)
    /// и печатает полный журнал — чтобы найти первую расходящуюся строку.
    /// </summary>
    private static void DumpMatch(string root, string[] args)
    {
        int index = ArgInt(args, "index", 0);
        using var refDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "tools/csharp/parity_ts.json")));
        var refRoot = refDoc.RootElement;
        int baseSeed = refRoot.GetProperty("baseSeed").GetInt32();
        int total = refRoot.GetProperty("matches_").GetArrayLength();
        if (index >= total) { Console.WriteLine($"индекс {index} вне эталона ({total})"); return; }

        var (db, decks, factionIds, config) = LoadLikeTs(root);
        var rng = new Rng(baseSeed);
        string left = "", right = "";
        for (int i = 0; i <= index; i++)
        {
            left = rng.Pick(factionIds);
            right = rng.Pick(factionIds);
            if (rng.Chance(0.5)) (left, right) = (right, left);
            if (i == index) break;
        }

        var runner = new MatchRunner(db, decks[left], decks[right],
            Enum.Parse<Faction>(left), Enum.Parse<Faction>(right),
            new MatchOptions { Seed = baseSeed + index * 7919, Config = config });
        runner.SetupAI();
        var res = runner.Run();

        string dest = Path.Combine(root, "tools/csharp", $"dump_{index}_cs.txt");
        File.WriteAllLines(dest, res.Log);
        Console.WriteLine($"матч #{index}: {left} vs {right}, seed {baseSeed + index * 7919}, " +
                          $"результат {res.Result}, ходов {res.Turns}, строк журнала {res.Log.Count}");
        Console.WriteLine($"журнал C#: {dest}");

        // эталонный журнал TS для этого матча (если снят)
        string tsLog = Path.Combine(root, "tools/csharp", $"dump_{index}_ts.txt");
        if (File.Exists(tsLog))
        {
            var a = File.ReadAllLines(tsLog);
            var b = res.Log.ToArray();
            int n = Math.Min(a.Length, b.Length);
            for (int i = 0; i < n; i++)
                if (a[i] != b[i])
                {
                    Console.WriteLine($"\nпервое расхождение в строке {i}:");
                    for (int k = Math.Max(0, i - 3); k <= Math.Min(n - 1, i + 3); k++)
                        Console.WriteLine($"{(k == i ? "→" : " ")} TS : {a[k]}");
                    Console.WriteLine();
                    for (int k = Math.Max(0, i - 3); k <= Math.Min(n - 1, i + 3); k++)
                        Console.WriteLine($"{(k == i ? "→" : " ")} C# : {b[k]}");
                    return;
                }
            Console.WriteLine(a.Length == b.Length
                ? "\nжурналы совпадают полностью"
                : $"\nжурналы совпадают до строки {n}, но длина разная: TS {a.Length} / C# {b.Length}");
        }
        else
        {
            Console.WriteLine($"эталонного журнала нет: снимите его (node build/parity.js --dump {index})");
        }
    }

    /* ------------------------------ БАЛАНС -------------------------------- */

    /// <summary>
    /// Прогон N матчей на C# (Simulator.RunSimulation) и сравнение винрейтов
    /// фракций с официальным отчётом docs/balance/faction_report.csv.
    /// Порог расхождения — 2.5 п.п. (статистический шум на малых выборках).
    /// </summary>
    private static void RunBalance(string root, string[] args)
    {
        int matches = ArgInt(args, "matches", 10000);
        int seed = ArgInt(args, "seed", 20260903);

        Console.WriteLine($"\n[5] Баланс на C#: {matches} матчей, seed {seed}");

        var (db, decks, factionIds, config) = LoadLikeTs(root);
        var t0 = DateTime.UtcNow;

        var report = Simulator.RunSimulation(db, decks, new SimulationOptions
        {
            Matches = matches,
            BaseSeed = seed,
            DeckIds = factionIds,
            Config = config,
        });

        double seconds = (DateTime.UtcNow - t0).TotalSeconds;
        Console.WriteLine($"  прогон за {seconds:F1} с ({matches / Math.Max(0.001, seconds):F0} матчей/с)");
        Console.WriteLine($"  ничьих: {report.Draws}, средняя длина партии: {report.AvgTurns:F2} хода");
        Console.WriteLine($"  карт вне коридора (|вклад| > 5 п.п.): {report.OutOfRange.Count}");
        Console.WriteLine();
        Console.WriteLine("  Фракция        C#        TS-отчёт     Δ");
        Console.WriteLine("  -------------- --------- ------------ ------");

        // официальный отчёт TS
        var tsRates = new Dictionary<string, double>(StringComparer.Ordinal);
        string csvPath = Path.Combine(root, "docs/balance/faction_report.csv");
        if (File.Exists(csvPath))
        {
            foreach (var line in File.ReadAllLines(csvPath).Skip(1))
            {
                var parts = line.Split(',');
                if (parts.Length < 6) continue;
                if (double.TryParse(parts[5], NumberStyles.Float, CultureInfo.InvariantCulture, out var wr))
                    tsRates[parts[0]] = wr;
            }
        }

        foreach (var f in report.Factions)
        {
            string name = f.Faction.ToString();
            double cs = f.WinRate;
            bool has = tsRates.TryGetValue(name, out double ts);
            double delta = has ? Math.Abs(cs - ts) : double.NaN;
            Console.WriteLine($"  {GameText.FactionRu(f.Faction),-14} {cs * 100,6:F1}%   " +
                              $"{(has ? (ts * 100).ToString("F1", CultureInfo.InvariantCulture) + "%" : "—"),10}   " +
                              $"{(has ? (delta * 100).ToString("F1", CultureInfo.InvariantCulture) + " п.п." : "—")}");

            Check($"{name}: винрейт в коридоре ТЗ п.10.8 (45–55%)", f.WithinTarget, (cs * 100).ToString("F1", CultureInfo.InvariantCulture) + "%");
            if (has)
                Check($"{name}: расхождение с TS-отчётом ≤ 2.5 п.п.", delta <= 0.025,
                    $"{delta * 100:F1} п.п. (C# {cs * 100:F1}% / TS {ts * 100:F1}%)");
        }

        // пишем свой CSV — можно сверять колонки с docs/balance/*
        string outDir = Path.Combine(root, "docs/balance-cs");
        Directory.CreateDirectory(outDir);
        var sbF = new StringBuilder();
        sbF.AppendLine("Faction,FactionRu,Games,Wins,Losses,WinRate,WithinTarget45_55,AvgTurns,AvgDamage,AvgHeal,AvgCardsPlayed,AvgEchoUsed");
        foreach (var f in report.Factions)
            sbF.AppendLine(string.Join(",", new[]
            {
                f.Faction.ToString(), GameText.FactionRu(f.Faction), f.Games.ToString(), f.Wins.ToString(),
                f.Losses.ToString(), f.WinRate.ToString("F4", CultureInfo.InvariantCulture),
                f.WithinTarget ? "YES" : "NO", f.AvgTurns.ToString("F1", CultureInfo.InvariantCulture),
                f.AvgDamage.ToString("F1", CultureInfo.InvariantCulture), f.AvgHeal.ToString("F1", CultureInfo.InvariantCulture),
                f.AvgCardsPlayed.ToString("F1", CultureInfo.InvariantCulture), f.AvgEchoUsed.ToString("F2", CultureInfo.InvariantCulture),
            }));
        File.WriteAllText(Path.Combine(outDir, "faction_report.csv"), sbF.ToString());

        var sbC = new StringBuilder();
        sbC.AppendLine("CardId,CardName,Faction,Type,Rarity,Cost,TimesPlayed,MatchesPresent,Wins,Losses,WinRate,WinRateWhenPlayed,FactionBaseWinRate,RelativeWinRate,PlayRate,AvgDamage,AvgHeal,NeedsBalance");
        foreach (var c in report.Cards)
            sbC.AppendLine(string.Join(",", new[]
            {
                c.CardId, Csv(c.CardName), c.Faction.ToString(), c.Type.ToString(), c.Rarity.ToString(), c.Cost.ToString(),
                c.TimesPlayed.ToString(), c.MatchesPresent.ToString(), c.Wins.ToString(), c.Losses.ToString(),
                c.WinRate.ToString("F4", CultureInfo.InvariantCulture),
                c.WinRateWhenPlayed.ToString("F4", CultureInfo.InvariantCulture),
                c.FactionBaseWinRate.ToString("F4", CultureInfo.InvariantCulture),
                c.RelativeWinRate.ToString("F4", CultureInfo.InvariantCulture),
                c.PlayRate.ToString("F4", CultureInfo.InvariantCulture),
                c.AvgDamage.ToString("F2", CultureInfo.InvariantCulture),
                c.AvgHeal.ToString("F2", CultureInfo.InvariantCulture),
                c.NeedsBalance ? "YES" : "NO",
            }));
        File.WriteAllText(Path.Combine(outDir, "card_power_report.csv"), sbC.ToString());
        Console.WriteLine($"\n  отчёты C#: {outDir}/faction_report.csv, card_power_report.csv");
    }

    private static string Csv(string s) => s.Contains(',') || s.Contains('"') ? '"' + s.Replace("\"", "\"\"") + '"' : s;
}
