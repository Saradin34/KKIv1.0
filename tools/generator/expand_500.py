#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ЭХО-ЦИТАДЕЛЬ — Расширение II «Архетипы»: доводит коллекцию до 500 карт (+200).
Четыря направления по ТЗ пользователя, всё на СУЩЕСТВУЮЩИХ опкодах движка
(+ новый op debuffHealth «Порча», v2.6):
  АГРО   : Мехи (Aurites), Гремлины (Pyromancer), Спрайты (Ethereal)
  ОТЖОР  : Вампиры (Necrus), Каннибалы (Pyromancer), Суккубы (Ethereal)
  ТОКЕНЫ : Энты (Terramorph), Братство паладинов (Aurites), Священное братство (Neutral)
  ЯД/ПОРЧА: Ведьмы (Necrus), Аспиды (Terramorph), Иссохшие (Neutral)
  + 32 нейтральных карты-связки (по 8 на направление).
Бюджет: docs/BALANCE_MODEL.md (power = 2*cost + 1.2, веса KW/OP). Детерминирован (SEED).
Побочно: пересобирает Decks.json (5 фракционных колод получают ядра архетипов,
40 карт, лимиты копий), дописывает meta.expansionIds (бустер-онли прогрессия).
"""
import json, os, collections

SEED = 20260922
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
PATH = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Cards.json')
DECKS = os.path.join(ROOT, 'unity', 'EchoCitadel', 'Assets', 'StreamingAssets', 'Decks.json')

KW_POWER = {'Taunt': .5, 'Rush': 1.0, 'Trample': .8, 'Unblockable': .7,
            'Lifesteal': 1.0, 'Windfury': 1.5, 'SpellDamage': .8, 'Deathrattle': .8, 'Battlecry': .6}
OP_POWER = {'damage': .9, 'heal': .7, 'draw': 1.6, 'buffAttack': .8, 'buffHealth': .8,
            'debuffAttack': .7, 'debuffHealth': .8, 'applyStatus': 1.2, 'silence': 1.2,
            'returnToHand': 1.3, 'destroyCreature': 2.4, 'gainEcho': 1.0, 'sacrifice': 1.6,
            'restoreHealthByAttack': 1.2, 'damageAllEnemyCreatures': 2.0, 'burnAllEnemies': 2.2,
            'freezeAllEnemies': 2.0, 'shieldAllFriendlies': 1.8, 'healAllFriendlyCreatures': 1.6,
            'mill': 1.2, 'stealCard': 1.5, 'stealCreature': 3.0, 'damageHeroes': 1.5,
            'summonToken': 0.0, 'extraCard': 1.4, 'opponentDraw': -1.0}

# ---------------------------------------------------------------- хелперы
def E(op, v=None, to=None, f=None):
    e = {'op': op}
    if v is not None: e['value'] = v
    if to: e['to'] = to
    if f: e['filter'] = f
    return e

def ST(status, to, turns=-1, sv=1, f=None):
    e = {'op': 'applyStatus', 'status': status, 'value': turns, 'statusValue': sv, 'to': to}
    if f: e['filter'] = f
    return e

def RND(n=1):
    return {'random': True, 'count': n}

def TOK(cid, name, fac, a, h, kws=()):
    return {'id': cid, 'name': name, 'faction': fac, 'type': 'Creature', 'rarity': 'Common',
            'cost': 1, 'attack': a, 'health': h, 'element': 'None', 'keywords': list(kws),
            'target': 'None', 'effects': [], 'abilityText': 'Токен', 'flavor': '',
            'isToken': True, 'tags': ['token']}

T_COG     = lambda: TOK('tkn_cog', 'Мех-обломок', 'Aurites', 1, 1)
T_GREM    = lambda: TOK('tkn_gremlin', 'Гремлин-налётчик', 'Pyromancer', 1, 1, ('Rush',))
T_SAP     = lambda: TOK('tkn_sapling', 'Росток Энта', 'Terramorph', 1, 2)
T_SQR     = lambda: TOK('tkn_squire', 'Оруженосец', 'Aurites', 1, 1)
T_ACOL    = lambda: TOK('tkn_acolyte', 'Послушник', 'Neutral', 1, 1)
T_RECR    = lambda: TOK('tkn_recruit', 'Рекрут', 'Neutral', 1, 1)

def C(name, rar, cost, atk=None, hp=None, kws=(), effs=(), ondeath=(), text='',
      target='None', elem='None', ctype='Creature', subtype=None):
    return {'name': name, 'rarity': rar, 'cost': cost,
            'attack': atk, 'health': hp, 'keywords': list(kws),
            'effects': list(effs), 'onDeath': list(ondeath), 'abilityText': text,
            'target': target, 'element': elem, 'type': ctype, 'subtype': subtype}

def S(name, rar, cost, effs, text, target='None', elem='None', subtype='Instant'):
    return C(name, rar, cost, None, None, (), effs, (), text, target, elem, 'Spell', subtype)

# ---------------------------------------------------------------- ПЛЕМЕНА
# (племя, фракция, направление, мотив арта, [14 карт])
TRIBES = [
 ('meh', 'Aurites', 'aggro', 'brass clockwork golem mech, gears and steam', [
   C('Мех-труженик', 'Common', 1, 1, 2, (), [], [], 'Роботизированный корпус: дёшев и надёжен.'),
   C('Скутер-ломщик', 'Common', 1, 2, 1, ('Rush',), [], [], 'Рывок. Ломает раньше, чем думает.'),
   C('Протокол «Страж»', 'Common', 2, 2, 3, ('Taunt',), [], [], 'Таунт. Линия охраны мануфактории.'),
   C('Штурмовой корпус', 'Common', 2, 2, 2, ('Rush',), [], [], 'Рывок. Стандартный штурмовой мех.'),
   C('Инженер Сборки', 'Common', 3, 3, 3, ('Battlecry',), [{'op': 'summonToken', 'token': T_COG()}], [], 'Боевой клич: призовите «Мех-обломок» 1/1.'),
   C('Обшивщик броней', 'Common', 3, 2, 4, ('Taunt', 'Battlecry'), [ST('Shield', 'FriendlyCreature', 2, 1, RND())], [], 'Боевой клич: случайный ваш персонаж получает Щит.'),
   C('Ремонтный дрон', 'Common', 4, 3, 5, ('Taunt',), [], [], 'Таунт. Чинит линию между ударами.'),
   C('Мех-громила', 'Uncommon', 3, 4, 3, ('Rush',), [], [], 'Рывок. Тяжёлая походка, тяжёлые кулаки.'),
   C('Конвейерный боец', 'Uncommon', 4, 3, 4, ('Battlecry',), [{'op': 'summonToken', 'token': T_COG()}], [], 'Боевой клич: призовите «Мех-обломок» 1/1.'),
   C('Осадный шагоход', 'Rare', 4, 4, 4, ('Rush', 'Trample'), [], [], 'Рывок, Прорыв. Стены — деталь ландшафта.'),
   C('Бастион Мануфактории', 'Rare', 6, 5, 7, ('Taunt', 'Battlecry'), [E('shieldAllFriendlies')], [], 'Боевой клич: все ваши существа получают Щит.'),
   C('Паровой потрошитель', 'Uncommon', 5, 5, 5, ('Windfury',), [], [], 'Буря. Два удара за такт котла.'),
   S('Перегрев', 'Common', 2, [E('buffAttack', 3, 'FriendlyCreature')], 'Дайте +3 атаки вашему существу. Шестерни воют.', 'FriendlyCreature'),
   C('Титан Мануфактории', 'Legendary', 8, 8, 8, ('Taunt', 'Windfury'), [], [], 'Таунт, Буря. Вершина часовой мысли.'),
 ]),
 ('grm', 'Pyromancer', 'aggro', 'feral goblin raider with torch and jagged knife', [
   C('Гремлин-шнырь', 'Common', 1, 2, 1, ('Rush',), [], [], 'Рывок. Мелкий, быстрый, противный.'),
   C('Гремлин-искра', 'Common', 1, 1, 1, ('Battlecry',), [E('damage', 1, 'EnemyHero')], [], 'Боевой клич: 1 урона герою противника.'),
   C('Налётчик стаи', 'Common', 2, 3, 1, ('Rush',), [], [], 'Рывок. Первый в волне.'),
   C('Гремлин-двойняшка', 'Common', 2, 2, 2, ('Windfury',), [], [], 'Буря. Бьёт дважды, смеётся четырежды.'),
   C('Рвач добычи', 'Common', 3, 4, 2, ('Rush',), [], [], 'Рывок. Тащит всё, что блестит.'),
   C('Вожак налёта', 'Common', 3, 3, 3, ('Battlecry',), [{'op': 'summonToken', 'token': T_GREM()}], [], 'Боевой клич: призовите «Гремлин-налётчик» 1/1 с Рывком.'),
   C('Трущобный нож', 'Uncommon', 2, 2, 2, ('Unblockable',), [], [], 'Неуловимость. Шнырь в переулках.'),
   C('Гремлин-подрывник', 'Uncommon', 4, 4, 4, ('Battlecry', 'Rush'), [E('damage', 2, 'EnemyCreature')], [], 'Рывок. Боевой клич: 2 урона существу.', 'EnemyCreature'),
   C('Бешеный резак', 'Rare', 3, 3, 2, ('Rush', 'Windfury'), [], [], 'Рывок, Буря. Четыре удара на третьем ходу.'),
   C('Клич стаи', 'Rare', 5, 5, 4, ('Battlecry',), [{'op': 'summonToken', 'token': T_GREM()}, {'op': 'summonToken', 'token': T_GREM()}], [], 'Боевой клич: призовите двух «Гремлин-налётчик» 1/1.'),
   S('Гремлин-бунт', 'Rare', 4, [E('damageAllEnemyCreatures', 2)], '2 урона всем существам противника: стая грызёт всё.', 'None'),
   C('Вождь Гремлинов', 'Legendary', 6, 6, 5, ('Rush', 'Windfury'), [], [], 'Рывок, Буря. Приказ: жги и беги.'),
   S('Угольная искра', 'Common', 1, [E('damage', 2, 'EnemyCreature')], '2 урона существу. Пахнет палёной шерстью.', 'EnemyCreature'),
   S('Ярость стаи', 'Uncommon', 2, [E('buffAttack', 2, 'FriendlyCreature')], '+2 атаки вашему существу. Стая воет.', 'FriendlyCreature'),
 ]),
 ('spr', 'Ethereal', 'aggro', 'glowing fae sprite with translucent wings', [
   C('Спрайт-мерцание', 'Common', 1, 1, 1, ('Unblockable',), [], [], 'Неуловимость. Его не поймать взглядом.'),
   C('Спрайт-осколок', 'Common', 1, 2, 2, (), [], [], 'Быстрый осколок звёздной пыли.'),
   C('Ночной шептун', 'Common', 2, 2, 2, ('Unblockable',), [], [], 'Неуловимость. Шепчет во сне.'),
   C('Спрайт-завеса', 'Common', 2, 2, 2, ('Unblockable',), [], [], 'Неуловимость. Держит край завесы.'),
   C('Звёздный налётчик', 'Common', 3, 4, 3, ('Unblockable',), [], [], 'Неуловимость. Пикирует сквозь свет.'),
   C('Хранительница мерцания', 'Common', 3, 3, 3, ('Unblockable', 'Battlecry'), [E('gainEcho', 1)], [], 'Неуловимость. Боевой клич: получите 1 Эхо.'),
   C('Спрайт-весть', 'Uncommon', 2, 2, 1, ('Unblockable', 'Battlecry'), [E('draw', 1)], [], 'Неуловимость. Боевой клич: возьмите 1 карту.'),
   C('Сумеречный клинок', 'Uncommon', 4, 5, 4, ('Unblockable',), [], [], 'Неуловимость. Режет по сумраку.'),
   C('Двойная вспышка', 'Rare', 3, 2, 2, ('Unblockable', 'Windfury'), [], [], 'Неуловимость, Буря. Две вспышки — одна рана.'),
   C('Спрайт-похититель', 'Rare', 5, 4, 4, ('Unblockable', 'Battlecry'), [E('mill', 2)], [], 'Неуловимость. Боевой клич: сбросьте 2 карты противника.'),
   S('Поток звёзд', 'Rare', 4, [E('draw', 2)], 'Возьмите 2 карты. Небо течёт сквозь рукав.', 'None'),
   C('Фантом-прилива', 'Legendary', 6, 5, 5, ('Unblockable', 'Trample'), [], [], 'Неуловимость, Прорыв. Волна, которой нет.'),
   S('Стремительность', 'Common', 2, [E('buffAttack', 3, 'FriendlyCreature')], '+3 атаки вашему существу. Миг — и нет его.', 'FriendlyCreature'),
   S('Лунная стрела', 'Uncommon', 3, [E('damage', 3, 'EnemyCreature')], '3 урона существу. Свет бьёт точнее стали.', 'EnemyCreature'),
 ]),
 ('vmp', 'Necrus', 'drain', 'pale vampire noble with crimson eyes', [
   C('Полуночный ловчий', 'Common', 2, 2, 3, ('Lifesteal',), [], [], 'Вампиризм: урон лечит вашего героя.'),
   C('Вурдалак-следопыт', 'Common', 3, 4, 3, ('Lifesteal',), [], [], 'Вампиризм. Знает цену каждой капле.'),
   C('Княжий отпрыск', 'Common', 4, 4, 4, ('Lifesteal',), [], [], 'Вампиризм. Наследник жажды.'),
   C('Кровавый привратник', 'Common', 2, 1, 3, ('Lifesteal', 'Taunt'), [], [], 'Вампиризм, Таунт. Кровь — его пошлина.'),
   C('Старейший жнец', 'Common', 4, 4, 4, ('Lifesteal',), [], [], 'Вампиризм. Жнёт и делится с родом.'),
   C('Нетопырь-резун', 'Uncommon', 3, 3, 2, ('Lifesteal', 'Rush'), [], [], 'Вампиризм, Рывок. Пикирует к шее.'),
   C('Целительница склепа', 'Uncommon', 4, 2, 4, ('Lifesteal', 'Battlecry'), [E('heal', 3, 'FriendlyHero')], [], 'Вампиризм. Боевой клич: 3 здоровья герою.'),
   C('Барон Багровой Луны', 'Uncommon', 6, 6, 6, ('Lifesteal',), [], [], 'Вампиризм. Луна наливается вместе с ним.'),
   C('Ламия-чревовещательница', 'Rare', 3, 2, 2, ('Lifesteal', 'Battlecry'), [{'op': 'restoreHealthByAttack', 'to': 'FriendlyHero'}], [], 'Боевой клич: лечение героя, равное атаке цели.'),
   C('Капеллан Жажды', 'Rare', 5, 4, 5, ('Lifesteal', 'Taunt'), [], [], 'Вампиризм, Таунт. Молится кровью.'),
   C('Патриарх Рода', 'Rare', 7, 7, 7, ('Lifesteal',), [], [], 'Вампиризм. Род пьёт вместе с ним.'),
   C('Сумрачная графиня', 'Legendary', 6, 5, 6, ('Lifesteal', 'Battlecry'), [E('mill', 3)], [], 'Вампиризм. Боевой клич: сбросьте 3 карты противника.'),
   S('Глоток крови', 'Common', 2, [E('heal', 5, 'FriendlyHero')], '5 здоровья вашему герою. Тёплый, железный привкус.', 'None'),
   S('Сифон души', 'Uncommon', 4, [E('damage', 3, 'EnemyCreature'), E('heal', 3, 'FriendlyHero')], '3 урона существу и 3 здоровья вашему герою.', 'EnemyCreature'),
 ]),
 ('cnb', 'Pyromancer', 'drain', 'savage cannibal warband brute with bone trophies', [
   C('Пожиратель падали', 'Common', 1, 2, 1, (), [], [], 'Ест то, что другие хоронят.'),
   C('Костегрыз', 'Common', 2, 3, 2, (), [], [], 'Глодает кость и чужую атаку.'),
   C('Трапезник войны', 'Common', 3, 3, 3, ('Battlecry',), [E('sacrifice'), E('buffAttack', 1, 'AllFriendlies'), E('buffHealth', 1, 'AllFriendlies')], [], 'Боевой клич: пожертвуйте существом — все ваши существа получают +2/+2.'),
   C('Обжора отряда', 'Common', 4, 4, 4, ('Battlecry',), [E('sacrifice'), E('buffAttack', 2, 'AllFriendlies'), E('buffHealth', 2, 'AllFriendlies')], [], 'Боевой клич: пожертвуйте существом — все ваши существа получают +3/+3.'),
   C('Прожорливый вал', 'Common', 5, 4, 5, ('Taunt', 'Battlecry'), [E('sacrifice'), E('buffAttack', 2, 'AllFriendlies'), E('buffHealth', 2, 'AllFriendlies')], [], 'Таунт. Боевой клич: пожертвуйте существом — все ваши получают +2/+2.'),
   C('Насыщенный зверь', 'Common', 2, 2, 2, ('Deathrattle',), [], [E('buffAttack', 1, 'AllFriendlies'), E('buffHealth', 1, 'AllFriendlies')], 'Предсмертный хрип: все ваши существа получают +1/+1.'),
   C('Рвач мяса', 'Uncommon', 3, 4, 2, ('Rush',), [], [], 'Рывок. Голод быстрее ног.'),
   C('Пиршественный шаман', 'Uncommon', 4, 3, 4, ('Battlecry',), [E('sacrifice'), E('draw', 2)], [], 'Боевой клич: пожертвуйте существом — возьмите 2 карты.'),
   C('Глот-костолом', 'Rare', 5, 4, 4, ('Battlecry',), [E('sacrifice'), E('buffAttack', 3, 'AllFriendlies'), E('buffHealth', 3, 'AllFriendlies')], [], 'Боевой клич: пожертвуйте существом — все ваши получают +3/+3.'),
   C('Пожиратель Костей', 'Rare', 7, 6, 6, ('Taunt', 'Battlecry'), [E('sacrifice'), E('destroyCreature', 1, 'EnemyCreature', RND())], [], 'Таунт. Боевой клич: пожертвуйте существом — уничтожьте случайное существо противника.'),
   S('Ритуал трапезы', 'Rare', 5, [E('sacrifice'), E('damage', 4, 'EnemyCreature')], 'Пожертвуйте существом: 4 урона существу. Пир богов.', 'EnemyCreature'),
   C('Матерь Обжорства', 'Legendary', 8, 7, 7, ('Battlecry', 'Trample'), [E('sacrifice'), E('buffAttack', 4, 'AllFriendlies'), E('buffHealth', 4, 'AllFriendlies')], [], 'Прорыв. Боевой клич: пожертвуйте существом — все ваши получают +4/+4.'),
   S('Сытная похлёбка', 'Common', 1, [E('buffAttack', 1, 'FriendlyCreature'), E('buffHealth', 1, 'FriendlyCreature')], '+1/+1 вашему существу. Наваристо.', 'FriendlyCreature'),
   S('Полное брюхо', 'Uncommon', 3, [E('heal', 4, 'FriendlyHero'), E('draw', 1)], '4 здоровья герою и 1 карта. Сытость мысли.', 'None'),
 ]),
 ('scc', 'Ethereal', 'drain', 'alluring succubus demoness with violet flame', [
   C('Суккуб-лихорадка', 'Common', 1, 1, 2, ('Lifesteal',), [], [], 'Вампиризм. Лёгкий жар в крови.'),
   C('Суккуб-полуночница', 'Common', 2, 2, 2, ('Lifesteal',), [], [], 'Вампиризм. Приходит на второй удар сердца.'),
   C('Чаровница вздохов', 'Common', 3, 3, 2, ('Lifesteal', 'Battlecry'), [E('mill', 1)], [], 'Вампиризм. Боевой клич: сбросьте 1 карту противника.'),
   C('Демонесса-обет', 'Common', 4, 3, 4, ('Lifesteal',), [], [], 'Вампиризм. Обет, скреплённый поцелуем.'),
   C('Суккуб-целительница', 'Common', 5, 5, 5, ('Lifesteal',), [], [], 'Вампиризм. Лечит своих, питаясь чужими.'),
   C('Шёпот искушения', 'Uncommon', 3, 2, 3, ('Lifesteal', 'Battlecry'), [E('heal', 2, 'FriendlyHero')], [], 'Вампиризм. Боевой клич: 2 здоровья герою.'),
   C('Госпожа Вуали', 'Uncommon', 4, 4, 3, ('Lifesteal', 'Battlecry'), [E('silence', 1, 'EnemyCreature')], [], 'Вампиризм. Боевой клич: немота существу противника.', 'EnemyCreature'),
   C('Суккуб-баронесса', 'Uncommon', 6, 6, 6, ('Lifesteal', 'Taunt'), [], [], 'Вампиризм, Таунт. Двор держит её голод.'),
   C('Поцелуй лихорадки', 'Rare', 4, 3, 3, ('Lifesteal', 'Battlecry'), [E('damage', 2, 'EnemyHero'), E('heal', 2, 'FriendlyHero')], [], 'Вампиризм. Боевой клич: 2 урона герою противника, 2 здоровья вашему.'),
   C('Ночная госпожа', 'Rare', 6, 6, 5, ('Lifesteal', 'Windfury'), [], [], 'Вампиризм, Буря. Две ночи за одну.'),
   S('Украденный сон', 'Common', 2, [E('mill', 2)], 'Сбросьте 2 карты противника. Пусть досматривает в могиле.', 'None'),
   S('Чары подчинения', 'Uncommon', 3, [E('silence', 1, 'EnemyCreature'), E('damage', 2, 'EnemyCreature')], 'Немота и 2 урона существу. Воля тает.', 'EnemyCreature'),
   C('Матерь Искушений', 'Legendary', 9, 8, 8, ('Lifesteal', 'Battlecry'), [E('stealCreature', 1, 'EnemyCreature', {'lowestAttack': True})], [], 'Вампиризм. Боевой клич: перехватите слабейшее существо противника.'),
   S('Обет крови', 'Rare', 5, [E('damage', 3, 'EnemyHero'), E('heal', 3, 'FriendlyHero')], '3 урона герою противника и 3 здоровья вашему.', 'None'),
 ]),
 ('ent', 'Terramorph', 'tokens', 'ancient bark ent with mossy shoulders', [
   C('Юный древень', 'Common', 2, 2, 3, ('Taunt',), [], [], 'Таунт. Ещё ребёнок, но уже стена.'),
   C('Энт-рощеносец', 'Common', 3, 2, 3, ('Taunt', 'Battlecry'), [{'op': 'summonToken', 'token': T_SAP()}], [], 'Таунт. Боевой клич: призовите «Росток Энта» 1/2.'),
   C('Старый корнеплёт', 'Common', 4, 3, 4, ('Taunt', 'Battlecry'), [{'op': 'summonToken', 'token': T_SAP()}], [], 'Таунт. Боевой клич: призовите «Росток Энта» 1/2.'),
   C('Дуб-часовой', 'Common', 5, 4, 5, ('Taunt',), [], [], 'Таунт. Стоит с Первой Посадки.'),
   C('Сеятель рощи', 'Common', 3, 2, 3, ('Battlecry',), [{'op': 'summonToken', 'token': T_SAP()}], [], 'Боевой клич: призовите «Росток Энта» 1/2.'),
   C('Кора-крепость', 'Common', 6, 5, 6, ('Taunt',), [], [], 'Таунт. Кора толще стен Цитадели.'),
   C('Энт-садовник', 'Uncommon', 4, 2, 5, ('Taunt', 'Battlecry'), [E('healAllFriendlyCreatures', 1)], [], 'Таунт. Боевой клич: 1 здоровья всем вашим существам.'),
   C('Ломоветвь', 'Uncommon', 5, 4, 5, ('Taunt', 'Trample'), [], [], 'Таунт, Прорыв. Ветви ломят строй.'),
   C('Рощемать', 'Rare', 4, 3, 4, ('Taunt', 'Battlecry'), [E('healAllFriendlyCreatures', 2)], [], 'Таунт. Боевой клич: 2 здоровья всем вашим существам.'),
   C('Древень-патриарх', 'Rare', 6, 5, 6, ('Taunt', 'Trample', 'Battlecry'), [{'op': 'summonToken', 'token': T_SAP()}], [], 'Таунт, Прорыв. Боевой клич: призовите «Росток Энта» 1/2.'),
   S('Буйный рост', 'Rare', 7, [{'op': 'summonToken', 'token': T_SAP()}, {'op': 'summonToken', 'token': T_SAP()}, {'op': 'summonToken', 'token': T_SAP()}], 'Призовите три «Росток Энта» 1/2. Роща наступает.', 'None', 'None', 'Ritual'),
   C('Древний Рощи', 'Legendary', 9, 7, 7, ('Taunt', 'Trample', 'Battlecry'), [{'op': 'summonToken', 'token': T_SAP()}, {'op': 'summonToken', 'token': T_SAP()}], [], 'Таунт, Прорыв. Боевой клич: два «Росток Энта» 1/2.'),
   S('Дубовая кожа', 'Common', 2, [E('buffHealth', 2, 'FriendlyCreature')], '+2 здоровья вашему существу. Кора вместо шрамов.', 'FriendlyCreature'),
   S('Весенний сок', 'Uncommon', 3, [E('healAllFriendlyCreatures', 3)], '3 здоровья всем вашим существам. Роща выдыхает.', 'None'),
 ]),
 ('pal', 'Aurites', 'tokens', 'knight paladin of a brotherhood with sun sigil', [
   C('Рядовой Братства', 'Common', 1, 1, 2, ('Taunt',), [], [], 'Таунт. Щит важнее славы.'),
   C('Оруженосец-наставник', 'Common', 2, 2, 2, ('Battlecry',), [{'op': 'summonToken', 'token': T_SQR()}], [], 'Боевой клич: призовите «Оруженосец» 1/1.'),
   C('Капеллан ордена', 'Common', 3, 3, 3, ('Battlecry',), [{'op': 'summonToken', 'token': T_SQR()}], [], 'Боевой клич: призовите «Оруженосец» 1/1.'),
   C('Щитоносец рассвета', 'Common', 4, 3, 4, ('Taunt',), [], [], 'Таунт. Встречает солнце первым.'),
   C('Сержант строя', 'Common', 5, 4, 5, ('Taunt',), [], [], 'Таунт. Держит линию и слово.'),
   C('Молодой рекрут', 'Common', 2, 2, 1, ('Battlecry',), [E('buffAttack', 1, 'FriendlyCreature', RND()), E('buffHealth', 1, 'FriendlyCreature', RND())], [], 'Боевой клич: случайный ваш персонаж получает +1/+1.'),
   C('Знаменосец', 'Uncommon', 3, 2, 3, ('Taunt', 'Battlecry'), [{'op': 'summonToken', 'token': T_SQR()}], [], 'Таунт. Боевой клич: призовите «Оруженосец» 1/1.'),
   C('Командор щитов', 'Uncommon', 4, 4, 4, ('Battlecry',), [E('shieldAllFriendlies')], [], 'Боевой клич: все ваши существа получают Щит.'),
   C('Маршал Братства', 'Rare', 4, 3, 3, ('Taunt', 'Battlecry'), [{'op': 'summonToken', 'token': T_SQR()}, {'op': 'summonToken', 'token': T_SQR()}], [], 'Таунт. Боевой клич: два «Оруженосец» 1/1.'),
   C('Светозарный судья', 'Rare', 6, 5, 6, ('Taunt', 'Lifesteal'), [], [], 'Таунт, Вампиризм. Суд милосерден и сыт.'),
   S('Благословение щитов', 'Rare', 5, [E('shieldAllFriendlies')], 'Все ваши существа получают Щит. Свет укрывает.', 'None'),
   C('Гроссмейстер Ордена', 'Legendary', 8, 6, 7, ('Taunt', 'Battlecry'), [{'op': 'summonToken', 'token': T_SQR()}, {'op': 'summonToken', 'token': T_SQR()}, {'op': 'summonToken', 'token': T_SQR()}], [], 'Таунт. Боевой клич: три «Оруженосец» 1/1.'),
   S('Обет стойкости', 'Common', 1, [E('buffAttack', 1, 'FriendlyCreature'), E('buffHealth', 2, 'FriendlyCreature')], '+1/+2 вашему существу. Стойкость — доспех души.', 'FriendlyCreature'),
   S('Молитва лазарета', 'Uncommon', 2, [E('heal', 4, 'FriendlyHero')], '4 здоровья вашему герою. Братство помнит раны.', 'None'),
 ]),
 ('sbd', 'Neutral', 'tokens', 'hooded monk of a sacred brotherhood with candle', [
   C('Послушник свечи', 'Common', 1, 1, 1, ('Battlecry',), [E('heal', 1, 'FriendlyHero')], [], 'Боевой клич: 1 здоровье вашему герою.'),
   C('Брат-привратник', 'Common', 2, 1, 3, ('Taunt',), [], [], 'Таунт. Дверь храма — его епархия.'),
   C('Странствующий проповедник', 'Common', 2, 2, 1, ('Battlecry',), [{'op': 'summonToken', 'token': T_ACOL()}], [], 'Боевой клич: призовите «Послушник» 1/1.'),
   C('Хоральный брат', 'Common', 3, 2, 3, ('Battlecry',), [{'op': 'summonToken', 'token': T_ACOL()}], [], 'Боевой клич: призовите «Послушник» 1/1.'),
   C('Наставник новиция', 'Common', 4, 3, 3, ('Battlecry',), [{'op': 'summonToken', 'token': T_ACOL()}, E('heal', 2, 'FriendlyHero')], [], 'Боевой клич: «Послушник» 1/1 и 2 здоровья герою.'),
   C('Мученик веры', 'Common', 3, 2, 2, ('Deathrattle',), [], [{'op': 'summonToken', 'token': T_ACOL()}], 'Предсмертный хрип: призовите «Послушник» 1/1.'),
   C('Целитель обители', 'Uncommon', 4, 3, 4, ('Battlecry',), [E('healAllFriendlyCreatures', 2)], [], 'Боевой клич: 2 здоровья всем вашим существам.'),
   C('Архимандрит', 'Uncommon', 5, 4, 4, ('Battlecry',), [{'op': 'summonToken', 'token': T_ACOL()}, {'op': 'summonToken', 'token': T_ACOL()}], [], 'Боевой клич: два «Послушник» 1/1.'),
   C('Светоч братства', 'Rare', 4, 2, 4, ('Taunt', 'Battlecry'), [E('heal', 3, 'FriendlyHero')], [], 'Таунт. Боевой клич: 3 здоровья вашему герою.'),
   C('Игумен процессий', 'Rare', 5, 4, 5, ('Battlecry',), [{'op': 'summonToken', 'token': T_ACOL()}, E('healAllFriendlyCreatures', 2)], [], 'Боевой клич: «Послушник» 1/1 и 2 здоровья всем вашим существам.'),
   S('Великая процессия', 'Rare', 6, [{'op': 'summonToken', 'token': T_ACOL()}, {'op': 'summonToken', 'token': T_ACOL()}, {'op': 'summonToken', 'token': T_ACOL()}], 'Призовите трёх «Послушник» 1/1. Пение слышно в Цитадели.', 'None', 'None', 'Ritual'),
   C('Патриарх Братства', 'Legendary', 7, 5, 6, ('Battlecry',), [E('heal', 6, 'FriendlyHero'), {'op': 'summonToken', 'token': T_ACOL()}, {'op': 'summonToken', 'token': T_ACOL()}], [], 'Боевой клич: 6 здоровья герою и два «Послушник» 1/1.'),
   S('Милостыня и молитва', 'Common', 2, [E('heal', 3, 'FriendlyHero'), E('draw', 1)], '3 здоровья герою и 1 карта. Братство делится.', 'None'),
   S('Елеосвящение', 'Uncommon', 3, [E('healAllFriendlyCreatures', 4)], '4 здоровья всем вашим существам. Елей и слово.', 'None'),
 ]),
 ('wtc', 'Necrus', 'poison', 'hag witch with toadstool crown and green fumes', [
   C('Ведьма-полуночница', 'Common', 2, 2, 2, ('Battlecry',), [ST('Poison', 'EnemyCreature', -1, 1, RND())], [], 'Боевой клич: Яд на случайное существо противника.'),
   C('Травница котла', 'Common', 3, 2, 3, ('Battlecry',), [ST('Burn', 'EnemyCreature', 2, 2, RND())], [], 'Боевой клич: Горение 2 на случайное существо противника.'),
   C('Сглаз-шептунья', 'Common', 4, 3, 3, ('Battlecry',), [ST('Poison', 'EnemyCreature')], [], 'Боевой клич: Яд на существо противника.', 'EnemyCreature'),
   C('Жаба-фамильяр', 'Common', 3, 1, 1, ('Battlecry',), [ST('Poison', 'EnemyCreature'), ST('Burn', 'EnemyCreature', 2, 1, RND())], [], 'Боевой клич: Яд на существо и Горение 1 на случайное.', 'EnemyCreature'),
   C('Котельная бабка', 'Common', 5, 4, 4, ('Battlecry',), [ST('Poison', 'EnemyCreature', -1, 1, {'random': True, 'count': 2})], [], 'Боевой клич: Яд на 2 случайных существа противника.'),
   C('Гнилая повитуха', 'Common', 2, 1, 3, ('Taunt', 'Deathrattle'), [], [ST('Poison', 'EnemyCreature', -1, 1, RND())], 'Таунт. Предсмертный хрип: Яд на случайное существо противника.'),
   C('Ведьма-сухорука', 'Uncommon', 3, 3, 2, ('Battlecry',), [E('silence', 1, 'EnemyCreature')], [], 'Боевой клич: немота существу противника.', 'EnemyCreature'),
   C('Полынная знахарка', 'Uncommon', 5, 4, 4, ('Battlecry',), [ST('Burn', 'EnemyCreature', 3, 3, RND())], [], 'Боевой клич: Горение 3 на случайное существо противника.'),
   C('Полуночная шептуха', 'Rare', 3, 2, 2, ('Unblockable', 'Battlecry'), [ST('Poison', 'EnemyCreature')], [], 'Неуловимость. Боевой клич: Яд на существо противника.', 'EnemyCreature'),
   C('Мать жабьего котла', 'Rare', 5, 4, 3, ('Battlecry',), [ST('Poison', 'EnemyCreature'), ST('Burn', 'EnemyCreature', 2, 2, RND())], [], 'Боевой клич: Яд на существо и Горение 2 на случайное.', 'EnemyCreature'),
   S('Моровая заря', 'Rare', 6, [ST('Poison', 'AllEnemies')], 'Яд на все существа противника: любая рана станет смертельной.', 'None', 'None', 'Ritual'),
   C('Матерь Ковена', 'Legendary', 6, 5, 6, ('Battlecry',), [ST('Poison', 'AllEnemies'), E('heal', 3, 'FriendlyHero')], [], 'Боевой клич: Яд на все существа противника и 3 здоровья герою.'),
   S('Искра сглаза', 'Common', 1, [ST('Burn', 'EnemyCreature', 2, 2)], 'Горение 2 на существо противника. Тлеет и шепчет.', 'EnemyCreature'),
   S('Ведьмин яд', 'Uncommon', 2, [ST('Poison', 'EnemyCreature'), E('draw', 1)], 'Яд на существо противника и 1 карта. Рецепт записан.', 'EnemyCreature'),
 ]),
 ('asp', 'Terramorph', 'poison', 'giant asp serpent with iridescent scales', [
   C('Аспид-плут', 'Common', 1, 1, 2, ('Battlecry',), [ST('Poison', 'EnemyCreature', -1, 1, RND())], [], 'Боевой клич: Яд на случайное существо противника.'),
   C('Чешуйчатый ползун', 'Common', 2, 2, 2, ('Unblockable',), [], [], 'Неуловимость. Скользит между стражей.'),
   C('Ядозуб', 'Common', 2, 2, 2, ('Battlecry',), [ST('Poison', 'EnemyCreature')], [], 'Боевой клич: Яд на существо противника.', 'EnemyCreature'),
   C('Ночная скользящая', 'Common', 3, 3, 3, ('Unblockable', 'Battlecry'), [ST('Poison', 'EnemyCreature', -1, 1, RND())], [], 'Неуловимость. Боевой клич: Яд на случайное существо противника.'),
   C('Аспид-удав', 'Common', 4, 3, 4, ('Battlecry',), [ST('Poison', 'EnemyCreature')], [], 'Боевой клич: Яд на существо противника.', 'EnemyCreature'),
   C('Гадюка-мать', 'Common', 3, 2, 2, ('Deathrattle',), [], [ST('Poison', 'EnemyCreature', -1, 1, RND())], 'Предсмертный хрип: Яд на случайное существо противника.'),
   C('Королевская кобра', 'Uncommon', 4, 4, 3, ('Unblockable',), [], [], 'Неуловимость. Капюшон — корона.'),
   C('Полоз-каменщук', 'Uncommon', 5, 3, 5, ('Taunt', 'Battlecry'), [ST('Poison', 'EnemyCreature', -1, 1, RND())], [], 'Таунт. Боевой клич: Яд на случайное существо противника.'),
   C('Стремительный клык', 'Rare', 3, 3, 1, ('Rush', 'Battlecry'), [ST('Poison', 'EnemyCreature')], [], 'Рывок. Боевой клич: Яд на существо противника.', 'EnemyCreature'),
   C('Радужный аспид', 'Rare', 5, 4, 4, ('Unblockable', 'Battlecry'), [ST('Poison', 'EnemyCreature')], [], 'Неуловимость. Боевой клич: Яд на существо противника.', 'EnemyCreature'),
   S('Двойной укус', 'Rare', 6, [ST('Poison', 'EnemyCreature', -1, 1, {'random': True, 'count': 2}), E('damage', 2, 'EnemyCreature')], 'Яд на 2 случайных существа и 2 урона существу.', 'EnemyCreature'),
   C('Прародитель Змей', 'Legendary', 6, 5, 5, ('Trample', 'Battlecry'), [ST('Poison', 'AllEnemies')], [], 'Прорыв. Боевой клич: Яд на все существа противника.'),
   S('Укус и жал', 'Common', 1, [E('damage', 2, 'EnemyCreature'), ST('Poison', 'EnemyCreature')], '2 урона существу и Яд на него. Укус двойной цены.', 'EnemyCreature'),
   S('Яд и лихорадка', 'Uncommon', 3, [ST('Poison', 'EnemyCreature'), ST('Burn', 'EnemyCreature', 2, 2)], 'Яд и Горение 2 на существо противника.', 'EnemyCreature'),
 ]),
 ('wtd', 'Neutral', 'poison', 'withered cursed husk pilgrim in rags', [
   C('Иссохший паломник', 'Common', 1, 1, 1, ('Battlecry',), [E('debuffAttack', 1, 'EnemyCreature')], [], 'Боевой клич: -1 атаки существу противника.'),
   C('Носитель порчи', 'Common', 2, 2, 2, ('Battlecry',), [E('debuffHealth', 1, 'EnemyCreature')], [], 'Боевой клич: Порча — -1 здоровья существу противника.'),
   C('Проклятый землепашец', 'Common', 3, 2, 3, ('Battlecry',), [E('debuffAttack', 2, 'EnemyCreature')], [], 'Боевой клич: -2 атаки существу противника.'),
   C('Иссохшая вдова', 'Common', 3, 3, 2, ('Battlecry',), [E('debuffHealth', 2, 'EnemyCreature', RND())], [], 'Боевой клич: Порча — -2 здоровья случайному существу противника.'),
   C('Могильный глашатай', 'Common', 4, 3, 4, ('Battlecry',), [E('debuffAttack', 1, 'EnemyCreature'), E('debuffHealth', 1, 'EnemyCreature')], [], 'Боевой клич: -1/-1 существу противника.'),
   C('Проклятый колосс', 'Common', 5, 4, 5, ('Battlecry',), [E('debuffHealth', 3, 'EnemyCreature')], [], 'Боевой клич: Порча — -3 здоровья существу противника.'),
   C('Иссохший хор', 'Common', 2, 1, 2, ('Deathrattle',), [], [E('debuffHealth', 1, 'AllEnemies')], 'Предсмертный хрип: все существа противника получают -1 здоровья.'),
   C('Сухорукий жнец', 'Uncommon', 4, 3, 3, ('Battlecry',), [E('debuffAttack', 3, 'EnemyCreature')], [], 'Боевой клич: -3 атаки существу противника.'),
   C('Пророк порчи', 'Uncommon', 5, 4, 4, ('Battlecry',), [E('debuffHealth', 2, 'EnemyCreature'), E('debuffAttack', 2, 'EnemyCreature')], [], 'Боевой клич: -2/-2 существу противника.'),
   C('Иссохший исполин', 'Rare', 6, 5, 5, ('Taunt', 'Battlecry'), [E('debuffHealth', 2, 'AllEnemies')], [], 'Таунт. Боевой клич: все существа противника получают -2 здоровья.'),
   C('Вестник проклятия', 'Rare', 5, 4, 4, ('Battlecry',), [E('debuffHealth', 3, 'EnemyCreature'), ST('Burn', 'EnemyCreature', 1, 1)], [], 'Боевой клич: Порча -3 здоровья и Горение 1 существу противника.'),
   S('Великое проклятие', 'Rare', 7, [E('debuffHealth', 4, 'EnemyCreature')], 'Порча: -4 здоровья существу противника. Земля сохнет под ним.', 'EnemyCreature'),
   C('Патриарх Иссохших', 'Legendary', 8, 7, 7, ('Battlecry',), [E('debuffHealth', 2, 'AllEnemies'), E('heal', 3, 'FriendlyHero')], [], 'Боевой клич: -2 здоровья всем существам противника, 3 здоровья вашему герою.'),
   S('Слабость', 'Common', 1, [E('debuffAttack', 2, 'EnemyCreature')], '-2 атаки существу противника. Руки опускаются.', 'EnemyCreature'),
 ]),
]

# --------------------------------------------- нейтральные связки (8×4 = 32)
NEUTRAL = [
 # агро
 C('Степной наездник', 'Common', 1, 2, 1, ('Rush',), [], [], 'Рывок. Ветер — его стремена.'),
 C('Тенёк из подворотни', 'Common', 1, 1, 1, ('Unblockable',), [], [], 'Неуловимость. Его не помнят в лицо.'),
 C('Наёмный клинок', 'Common', 2, 3, 1, ('Rush',), [], [], 'Рывок. Оплачен вперёд.'),
 C('Серый ветеран', 'Common', 2, 2, 2, (), [], [], 'Без чудес. Просто надёжен.'),
 C('Разведчица дюн', 'Uncommon', 2, 2, 1, ('Rush', 'Battlecry'), [E('damage', 1, 'EnemyHero')], [], 'Рывок. Боевой клич: 1 урон герою противника.'),
 C('Копейщик авангарда', 'Uncommon', 3, 3, 2, ('Rush',), [], [], 'Рывок. Первый ряд, первый удар.'),
 S('Рывок вперёд', 'Rare', 2, [E('buffAttack', 3, 'FriendlyCreature')], '+3 атаки вашему существу. Агро не ждёт.', 'FriendlyCreature'),
 S('Быстрый выпад', 'Common', 1, [E('damage', 2, 'EnemyCreature')], '2 урона существу. Один выпад — одна дыра.', 'EnemyCreature'),
 # отжор
 C('Пиявка-кровосос', 'Common', 2, 2, 2, ('Lifesteal',), [], [], 'Вампиризм. Мелкая, но жадная.'),
 C('Шакал-падальщик', 'Common', 3, 3, 3, ('Lifesteal',), [], [], 'Вампиризм. Доедает за войной.'),
 C('Вампир-отступник', 'Common', 4, 4, 3, ('Lifesteal',), [], [], 'Вампиризм. Изгнан, но сыт.'),
 C('Монахиня-кровопийца', 'Uncommon', 3, 2, 3, ('Lifesteal', 'Taunt'), [], [], 'Вампиризм, Таунт. Молится губами.'),
 C('Гуль-гурман', 'Uncommon', 5, 5, 4, ('Lifesteal',), [], [], 'Вампиризм. Разбирает жертву по вкусу.'),
 S('Круг крови', 'Rare', 4, [E('damage', 3, 'EnemyCreature'), E('heal', 3, 'FriendlyHero')], '3 урона существу и 3 здоровья вашему герою.', 'EnemyCreature'),
 C('Химера-кровохлёб', 'Rare', 6, 6, 6, ('Lifesteal',), [], [], 'Вампиризм. Три пасти — один аппетит.'),
 S('Живительный отвар', 'Common', 2, [E('heal', 4, 'FriendlyHero')], '4 здоровья вашему герою. Горько, но живо.', 'None'),
 # токены
 C('Сержант новобранцев', 'Common', 2, 2, 2, ('Battlecry',), [{'op': 'summonToken', 'token': T_RECR()}], [], 'Боевой клич: призовите «Рекрут» 1/1.'),
 C('Знаменосец роты', 'Common', 3, 3, 2, ('Battlecry',), [{'op': 'summonToken', 'token': T_RECR()}], [], 'Боевой клич: призовите «Рекрут» 1/1.'),
 C('Капитан ополчения', 'Common', 4, 3, 4, ('Battlecry',), [{'op': 'summonToken', 'token': T_RECR()}], [], 'Боевой клич: призовите «Рекрут» 1/1.'),
 C('Комендант форта', 'Uncommon', 4, 2, 4, ('Taunt', 'Battlecry'), [{'op': 'summonToken', 'token': T_RECR()}], [], 'Таунт. Боевой клич: призовите «Рекрут» 1/1.'),
 C('Генерал резерва', 'Uncommon', 5, 4, 4, ('Battlecry',), [{'op': 'summonToken', 'token': T_RECR()}, {'op': 'summonToken', 'token': T_RECR()}], [], 'Боевой клич: два «Рекрут» 1/1.'),
 S('Мобилизация', 'Rare', 3, [{'op': 'summonToken', 'token': T_RECR()}, {'op': 'summonToken', 'token': T_RECR()}], 'Призовите двух «Рекрут» 1/1. Рота, стройся!', 'None'),
 C('Маршал легионов', 'Rare', 6, 5, 5, ('Battlecry',), [{'op': 'summonToken', 'token': T_RECR()}, {'op': 'summonToken', 'token': T_RECR()}, {'op': 'summonToken', 'token': T_RECR()}], [], 'Боевой клич: три «Рекрут» 1/1.'),
 S('Ротный писарь', 'Common', 2, [E('draw', 2), {'op': 'summonToken', 'token': T_RECR()}], 'Возьмите 2 карты и призовите «Рекрут» 1/1.', 'None'),
 # яд/порча
 S('Тлеющая порча', 'Common', 2, [ST('Burn', 'EnemyCreature', 1, 1)], 'Горение 1 на существо противника. Тлеет незаметно.', 'EnemyCreature'),
 C('Чумной крысолов', 'Common', 2, 2, 1, ('Battlecry',), [ST('Poison', 'EnemyCreature', -1, 1, RND())], [], 'Боевой клич: Яд на случайное существо противника.'),
 S('Скверна', 'Common', 3, [ST('Poison', 'EnemyCreature')], 'Яд на существо противника: любая рана станет смертельной.', 'EnemyCreature'),
 C('Проклятый могильщик', 'Common', 3, 2, 3, ('Battlecry',), [E('debuffHealth', 1, 'EnemyCreature')], [], 'Боевой клич: Порча — -1 здоровья существу противника.'),
 C('Знахарь-отравитель', 'Uncommon', 4, 3, 3, ('Battlecry',), [ST('Poison', 'EnemyCreature', -1, 1, RND()), ST('Burn', 'EnemyCreature', 1, 1, RND())], [], 'Боевой клич: Яд и Горение 1 на случайных существ противника.'),
 S('Порча и немощь', 'Uncommon', 4, [E('debuffHealth', 2, 'EnemyCreature'), E('debuffAttack', 1, 'EnemyCreature')], '-2 здоровья и -1 атаки существу противника.', 'EnemyCreature'),
 C('Носитель чумы', 'Rare', 5, 4, 4, ('Battlecry',), [ST('Poison', 'EnemyCreature')], [], 'Боевой клич: Яд на существо противника.', 'EnemyCreature'),
 S('Эпидемия', 'Rare', 5, [ST('Poison', 'EnemyCreature', -1, 1, {'random': True, 'count': 2}), ST('Burn', 'EnemyCreature', 2, 2, {'random': True, 'count': 2})], 'Яд и Горение 2 на 2 случайных существа противника.', 'None'),
]

FLAVOR = [
 '«Эхо помнит даже то, что Цитадель предпочла забыть.»',
 '«Цена силы — след, который она оставляет.»',
 '«Руины — это не конец. Это черновик.»',
 '«Свет не спорит с тьмой. Он просто приходит.»',
 '«Корни глубже стен. Всегда глубже.»',
 '«Пепел честнее золота: он не притворяется.»',
 '«Голод — тоже молитва, только тихая.»',
 '«Яд не спешит: он знает, куда идёт.»',
]

def eff_power(effects):
    p = 0.0
    for e in effects or []:
        op = e.get('op')
        if op == 'summonToken':
            t = e.get('token') or {}
            p += (t.get('attack', 0) + t.get('health', 0)) * 0.45 + sum(KW_POWER.get(k, 0) for k in t.get('keywords', []))
        else:
            p += OP_POWER.get(op, 0.0) * (1.0 if e.get('value') in (None, 1) else min(1.6, 0.6 + 0.2 * (e.get('value') or 1)))
        if e.get('filter'):
            p *= 0.85
    return p

def main():
    d = json.load(open(PATH, encoding='utf-8'))
    PREF = ('meh_', 'grm_', 'spr_', 'vmp_', 'cnb_', 'scc_', 'ent_', 'pal_',
            'sbd_', 'wtc_', 'asp_', 'wtd_', 'nsu_')
    d['cards'] = [c for c in d['cards'] if not c['id'].startswith(PREF)]
    dk0 = json.load(open(DECKS, encoding='utf-8'))
    for deck in dk0['decks']:
        deck['cards'] = [cid for cid in deck['cards'] if not cid.startswith(PREF)]
    json.dump(dk0, open(DECKS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    cards = d['cards']
    have = {c['id'] for c in cards}
    names = {c['name'] for c in cards}
    added, exp_ids, WARN = [], [], []

    def emit(prefix, fac, direction, motif, lst):
        for i, c in enumerate(lst, 1):
            cid = f'{prefix}_{i:02d}'
            assert cid not in have, f'dup id {cid}'
            assert c['name'] not in names, f'dup name {c["name"]}'
            names.add(c['name'])
            assert len(c['abilityText']) <= 118, f'text too long: {c["name"]}'
            c = dict(c)
            c['id'] = cid
            c['faction'] = fac
            c['flavor'] = FLAVOR[(i + len(added)) % len(FLAVOR)]
            c['tags'] = ['card', direction, prefix]
            c['art'] = f'Resources/Cards/{fac}/{cid}.png'
            c['artworkPath'] = c['art']
            c['artPrompt'] = f'dark fantasy trading card game illustration, {motif}: "{c["name"]}"'
            c['negativePrompt'] = 'text, letters, watermark, frame borders'
            c['artSize'] = '512x720'
            c.setdefault('keywords', [])
            c.setdefault('effects', [])
            c.setdefault('onDeath', [])
            if c['type'] == 'Creature' and (c['effects'] or c['onDeath']) and 'Battlecry' not in c['keywords'] and c['effects']:
                c['keywords'].insert(0, 'Battlecry')
            if c['onDeath'] and 'Deathrattle' not in c['keywords']:
                c['keywords'].append('Deathrattle')
            if c['type'] == 'Creature':
                budget = 2 * c['cost'] + 1.2
                got = (c['attack'] or 0) + (c['health'] or 0) + sum(KW_POWER.get(k, 0) for k in c['keywords']) + eff_power(c['effects']) + eff_power(c['onDeath']) * .8
                if abs(got - budget) > 2.2:
                    WARN.append(f'budget {cid}: {got:.1f} vs {budget:.1f}')
            added.append(c)
            exp_ids.append(cid)

    for prefix, fac, direction, motif, lst in TRIBES:
        emit(prefix, fac, direction, motif, lst)
    emit('nsu', 'Neutral', 'support', 'wandering mercenary of the echo lands', NEUTRAL)

    assert len(added) == 200, len(added)
    d['cards'] = cards + added
    m = d['meta']
    m['version'] = '3.0.0'
    m['totalCards'] = len(d['cards'])
    m['generatedAt'] = '2026-09-22'
    m['expansion'] = {'set': 'Эхо-Цитадель: Расширение II «Архетипы»', 'code': 'ECH2', 'added': len(added),
                      'note': '4 направления: агро (Мехи/Гремлины/Спрайты), отжор (Вампиры/Каннибалы/Суккубы), '
                              'токены (Энты/Братство паладинов/Священное братство), яд и порча (Ведьмы/Аспиды/Иссохшие). '
                              'Новый op: debuffHealth (Порча).'}
    m['expansionIds'] = sorted(set(m.get('expansionIds', [])) | set(exp_ids))
    m['distribution']['types'] = dict(collections.Counter(c['type'] for c in d['cards']))
    m['distribution']['rarities'] = dict(collections.Counter(c['rarity'] for c in d['cards']))
    json.dump(d, open(PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    # ---- ребилд фракционных колод: ядра архетипов + база (40 карт, лимиты)
    dk = json.load(open(DECKS, encoding='utf-8'))
    trib_by_fac = collections.defaultdict(list)
    for prefix, fac, direction, motif, lst in TRIBES:
        trib_by_fac[fac].append(prefix)
    newby = collections.defaultdict(list)
    for c in added:
        newby[c['faction']].append(c)
    # ---- v6: детерминированный добор — абсолютная сила по бюджетной модели
    # (без контекста режима: не осциллирует), квоты типов, кривая, лимиты копий
    def _power(c):
        p = 0.0
        if c['type'] == 'Creature':
            p += (c.get('attack') or 0) + (c.get('health') or 0)
        p += sum(KW_POWER.get(k, 0) for k in c.get('keywords', []))
        p += eff_power(c.get('effects')) + 0.8 * eff_power(c.get('onDeath'))
        return p
    BROKEN = {'aur_r09', 'aur_r10', 'aur_r11', 'nec_r09', 'nec_r08', 'nec_r07', 'ter_r09'}
    CURVE_CAP = {0: 4, 1: 6, 2: 8, 3: 8, 4: 6, 5: 5, 6: 3, 7: 99}
    NEUT_Q = 4  # v7: симметрично всем фракциям
    TYPE_QUOTA = {'Creature': 24, 'Spell': 10, 'Rune': 6}
    for deck in dk['decks']:
        if deck['id'] == 'Starter':
            continue
        fac = deck.get('faction') or deck['id']
        mine = [c for c in added if c['faction'] == fac]
        cms = sorted([c for c in mine if c['rarity'] != 'Legendary'], key=lambda c: (c['cost'], c['id']))
        arch = cms[:7]  # v7: единое правило — 7 cheapest
        legs = sorted([c for c in mine if c['rarity'] == 'Legendary'], key=lambda c: c['cost'])[:2]
        lst = []
        for c in arch:
            lst += [c['id'], c['id']]
        for c in legs:
            lst.append(c['id'])
        used = collections.Counter(lst)
        curv = collections.Counter()
        tused = collections.Counter()
        for cid in lst:
            _cc = next(x for x in d['cards'] if x['id'] == cid)
            curv[min(_cc['cost'], 7)] += 1
            tused[_cc['type']] += 1
        pool = [c for c in d['cards']
                if c['faction'] == fac and not c.get('isToken') and c['id'] not in BROKEN]
        neut_pool = [c for c in d['cards']
                if c['faction'] == 'Neutral' and c['type'] == 'Creature' and not c.get('isToken')]
        neut_pool.sort(key=lambda c: (-(_power(c) - (2 * c['cost'] + 1.2)), c['cost'], c['id']))
        neut_used = 0
        pool.sort(key=lambda c: (-(_power(c) - (2 * c['cost'] + 1.2)), c['cost'], c['id']))
        for c in pool + neut_pool:
            if len(lst) >= 40:
                break
            lim = 1 if c['rarity'] == 'Legendary' else 2
            if used[c['id']] >= lim:
                continue
            if tused[c['type']] >= TYPE_QUOTA.get(c['type'], 99):
                continue
            if c['faction'] == 'Neutral' and neut_used >= NEUT_Q:
                continue
            if curv[min(c['cost'], 7)] >= CURVE_CAP[min(c['cost'], 7)]:
                continue
            lst.append(c['id']); used[c['id']] += 1
            curv[min(c['cost'], 7)] += 1; tused[c['type']] += 1
            if c['faction'] == 'Neutral':
                neut_used += 1
        _fb = sorted([c for c in pool + neut_pool if c['type'] == 'Creature'], key=lambda c: (c['cost'], c['id']))
        _fb += sorted([c for c in pool if c['type'] == 'Spell'], key=lambda c: (c['cost'], c['id']))
        _fb += sorted([c for c in pool if c['type'] == 'Rune'], key=lambda c: (c['cost'], c['id']))
        for c in _fb:
            if len(lst) >= 40:
                break
            if c['faction'] == 'Neutral' and neut_used >= NEUT_Q:
                continue
            lim = 1 if c['rarity'] == 'Legendary' else 2
            if used[c['id']] < lim:
                lst.append(c['id']); used[c['id']] += 1
                if c['faction'] == 'Neutral':
                    neut_used += 1
        deck['cards'] = lst[:40]
        cnt = collections.Counter(deck['cards'])
        assert len(deck['cards']) == 40, (deck['id'], len(deck['cards']))
        for cid, n in cnt.items():
            rar = next((c['rarity'] for c in d['cards'] if c['id'] == cid), 'Common')
            assert n <= (1 if rar == 'Legendary' else 2), (deck['id'], cid, n)
    dk['meta'] = dk.get('meta', {})
    dk['meta']['updated'] = '2026-09-22'
    dk['meta']['note'] = 'v6: свои пулы + добор по бюджетной модели + ядра ECH2'
    json.dump(dk, open(DECKS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    if WARN:
        print('⚠ бюджетные предупреждения (баланс-сим уточнит):')
        for w in WARN: print('   ', w)
    print(f'✔ Cards.json: {len(cards)} → {len(cards) + len(added)} (+{len(added)})')
    print('  редкости новых:', dict(collections.Counter(c['rarity'] for c in added)))
    print('  фракции всего:', dict(collections.Counter(c['faction'] for c in d['cards'])))
    print('  expansionIds:', len(m['expansionIds']))
    for deck in dk['decks']:
        print(f"  колода {deck['id']}: {len(deck['cards'])} карт")

if __name__ == '__main__':
    main()
