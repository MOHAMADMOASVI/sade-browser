// Occasions shown on the dashboard, looked up by today's date in three calendars.
// Each row: [calendar, month, day, audience, Persian, English, Russian]
//   calendar: 'p' Persian (Solar Hijri), 'g' Gregorian, 'h' Islamic (lunar)
//   audience: 'world' everyone, 'ir' Persian and English, 'ru' Russian only
// Lunar dates are computed, not sighted, so they can be a day off from the
// official calendar.
;(function (root) {
  const LIST = [
    // Persian calendar
    ['p', 1, 1, 'ir', 'نوروز — آغاز سال نو', 'Nowruz — Persian New Year', 'Новруз — персидский Новый год'],
    ['p', 1, 2, 'ir', 'عید نوروز', 'Nowruz holiday', 'Праздник Новруз'],
    ['p', 1, 3, 'ir', 'عید نوروز', 'Nowruz holiday', 'Праздник Новруз'],
    ['p', 1, 4, 'ir', 'عید نوروز', 'Nowruz holiday', 'Праздник Новруз'],
    ['p', 1, 12, 'ir', 'روز جمهوری اسلامی', 'Islamic Republic Day', 'День Исламской Республики'],
    ['p', 1, 13, 'ir', 'سیزده‌به‌در — روز طبیعت', 'Sizdah Bedar — Nature Day', 'Сиздах-бедар — День природы'],
    ['p', 2, 10, 'ir', 'روز ملی خلیج فارس', 'Persian Gulf National Day', 'Национальный день Персидского залива'],
    ['p', 2, 12, 'ir', 'روز معلم', 'Teachers’ Day (Iran)', 'День учителя (Иран)'],
    ['p', 2, 25, 'ir', 'روز بزرگداشت فردوسی', 'Ferdowsi Day', 'День Фирдоуси'],
    ['p', 2, 28, 'ir', 'روز بزرگداشت خیام', 'Khayyam Day', 'День Омара Хайяма'],
    ['p', 3, 14, 'ir', 'رحلت امام خمینی', 'Anniversary of Imam Khomeini’s death', 'Годовщина смерти имама Хомейни'],
    ['p', 3, 15, 'ir', 'قیام ۱۵ خرداد', '15 Khordad uprising', 'Восстание 15 хордада'],
    ['p', 4, 13, 'ir', 'جشن تیرگان', 'Tirgan festival', 'Праздник Тирган'],
    ['p', 5, 14, 'ir', 'روز صدور فرمان مشروطیت', 'Constitutional Revolution Day', 'День Конституционной революции'],
    ['p', 5, 17, 'ir', 'روز خبرنگار', 'Journalists’ Day (Iran)', 'День журналиста (Иран)'],
    ['p', 6, 1, 'ir', 'روز پزشک — بزرگداشت ابن‌سینا', 'Doctors’ Day — Avicenna Day', 'День врача — День Авиценны'],
    ['p', 6, 5, 'ir', 'روز داروساز — بزرگداشت رازی', 'Pharmacists’ Day — Razi Day', 'День фармацевта — День ар-Рази'],
    ['p', 6, 13, 'ir', 'روز بزرگداشت ابوریحان بیرونی', 'Biruni Day', 'День аль-Бируни'],
    ['p', 6, 27, 'ir', 'روز شعر و ادب فارسی', 'Persian Poetry and Literature Day', 'День персидской поэзии и литературы'],
    ['p', 7, 7, 'ir', 'روز آتش‌نشانی و ایمنی', 'Firefighters’ Day (Iran)', 'День пожарного (Иран)'],
    ['p', 7, 8, 'ir', 'روز بزرگداشت مولوی', 'Rumi Day', 'День Руми'],
    ['p', 7, 10, 'ir', 'جشن مهرگان', 'Mehregan festival', 'Праздник Мехреган'],
    ['p', 7, 20, 'ir', 'روز بزرگداشت حافظ', 'Hafez Day', 'День Хафиза'],
    ['p', 8, 13, 'ir', 'روز دانش‌آموز', 'Students’ Day (school)', 'День школьника'],
    ['p', 8, 24, 'ir', 'روز کتاب و کتاب‌خوانی', 'Book and Reading Day', 'День книги и чтения'],
    ['p', 9, 16, 'ir', 'روز دانشجو', 'University Students’ Day', 'День студента'],
    ['p', 9, 30, 'ir', 'شب یلدا', 'Yalda Night', 'Ночь Ялда'],
    ['p', 11, 22, 'ir', 'پیروزی انقلاب اسلامی', 'Anniversary of the Islamic Revolution', 'Годовщина Исламской революции'],
    ['p', 12, 5, 'ir', 'روز مهندس — بزرگداشت خواجه نصیرالدین طوسی', 'Engineers’ Day — Nasir al-Din Tusi Day', 'День инженера — День ат-Туси'],
    ['p', 12, 15, 'ir', 'روز درختکاری', 'Tree Planting Day', 'День посадки деревьев'],
    ['p', 12, 29, 'ir', 'روز ملی شدن صنعت نفت', 'Oil Nationalization Day', 'День национализации нефтяной промышленности'],

    // Islamic (lunar) calendar
    ['h', 1, 9, 'ir', 'تاسوعای حسینی', 'Tasua', 'Тасуа'],
    ['h', 1, 10, 'ir', 'عاشورای حسینی', 'Ashura', 'Ашура'],
    ['h', 2, 20, 'ir', 'اربعین حسینی', 'Arbaeen', 'Арбаин'],
    ['h', 2, 28, 'ir', 'رحلت پیامبر اکرم و شهادت امام حسن مجتبی', 'Death of Prophet Muhammad and martyrdom of Imam Hasan', 'Кончина пророка Мухаммеда и мученичество имама Хасана'],
    ['h', 3, 17, 'ir', 'میلاد پیامبر اکرم و امام جعفر صادق', 'Birthday of Prophet Muhammad and Imam Sadiq', 'Рождение пророка Мухаммеда и имама Садыка'],
    ['h', 6, 3, 'ir', 'شهادت حضرت فاطمه زهرا', 'Martyrdom of Fatima Zahra', 'Мученичество Фатимы Захры'],
    ['h', 6, 20, 'ir', 'ولادت حضرت فاطمه زهرا — روز مادر', 'Birthday of Fatima Zahra — Mother’s Day', 'Рождение Фатимы Захры — День матери'],
    ['h', 7, 13, 'ir', 'ولادت امام علی — روز پدر', 'Birthday of Imam Ali — Father’s Day', 'Рождение имама Али — День отца'],
    ['h', 7, 27, 'ir', 'عید مبعث', 'Mab’ath', 'Мабас'],
    ['h', 8, 15, 'ir', 'نیمهٔ شعبان — ولادت امام زمان', 'Mid-Sha’ban — Birthday of Imam Mahdi', 'Середина шаабана — рождение имама Махди'],
    ['h', 9, 1, 'ir', 'آغاز ماه رمضان', 'Start of Ramadan', 'Начало Рамадана'],
    ['h', 9, 21, 'ir', 'شهادت امام علی', 'Martyrdom of Imam Ali', 'Мученичество имама Али'],
    ['h', 10, 1, 'ir', 'عید سعید فطر', 'Eid al-Fitr', 'Ураза-байрам'],
    ['h', 10, 25, 'ir', 'شهادت امام جعفر صادق', 'Martyrdom of Imam Sadiq', 'Мученичество имама Садыка'],
    ['h', 12, 10, 'ir', 'عید سعید قربان', 'Eid al-Adha', 'Курбан-байрам'],
    ['h', 12, 18, 'ir', 'عید سعید غدیر خم', 'Eid al-Ghadir', 'Ид аль-Гадир'],

    // Gregorian calendar
    ['g', 1, 1, 'world', 'آغاز سال نو میلادی', 'New Year’s Day', 'Новый год'],
    ['g', 2, 11, 'world', 'روز جهانی زنان و دختران در علم', 'International Day of Women and Girls in Science', 'Международный день женщин и девочек в науке'],
    ['g', 2, 14, 'world', 'روز ولنتاین', 'Valentine’s Day', 'День святого Валентина'],
    ['g', 2, 21, 'world', 'روز جهانی زبان مادری', 'International Mother Language Day', 'Международный день родного языка'],
    ['g', 3, 8, 'world', 'روز جهانی زن', 'International Women’s Day', 'Международный женский день'],
    ['g', 3, 22, 'world', 'روز جهانی آب', 'World Water Day', 'Всемирный день водных ресурсов'],
    ['g', 4, 7, 'world', 'روز جهانی بهداشت', 'World Health Day', 'Всемирный день здоровья'],
    ['g', 4, 22, 'world', 'روز زمین', 'Earth Day', 'День Земли'],
    ['g', 4, 23, 'world', 'روز جهانی کتاب', 'World Book Day', 'Всемирный день книги'],
    ['g', 5, 1, 'world', 'روز جهانی کارگر', 'International Workers’ Day', 'Праздник Весны и Труда'],
    ['g', 5, 3, 'world', 'روز جهانی آزادی مطبوعات', 'World Press Freedom Day', 'Всемирный день свободы печати'],
    ['g', 5, 18, 'world', 'روز جهانی موزه', 'International Museum Day', 'Международный день музеев'],
    ['g', 6, 5, 'world', 'روز جهانی محیط زیست', 'World Environment Day', 'Всемирный день окружающей среды'],
    ['g', 6, 20, 'world', 'روز جهانی پناهندگان', 'World Refugee Day', 'Всемирный день беженцев'],
    ['g', 7, 11, 'world', 'روز جهانی جمعیت', 'World Population Day', 'Всемирный день народонаселения'],
    ['g', 8, 12, 'world', 'روز جهانی جوانان', 'International Youth Day', 'Международный день молодёжи'],
    ['g', 9, 8, 'world', 'روز جهانی سوادآموزی', 'International Literacy Day', 'Международный день грамотности'],
    ['g', 9, 21, 'world', 'روز جهانی صلح', 'International Day of Peace', 'Международный день мира'],
    ['g', 9, 27, 'world', 'روز جهانی گردشگری', 'World Tourism Day', 'Всемирный день туризма'],
    ['g', 10, 1, 'world', 'روز جهانی سالمندان', 'International Day of Older Persons', 'Международный день пожилых людей'],
    ['g', 10, 5, 'world', 'روز جهانی معلم', 'World Teachers’ Day', 'Всемирный день учителя'],
    ['g', 10, 10, 'world', 'روز جهانی سلامت روان', 'World Mental Health Day', 'Всемирный день психического здоровья'],
    ['g', 10, 13, 'world', 'روز جهانی کاهش خطر بلایا', 'International Day for Disaster Risk Reduction', 'Международный день уменьшения опасности бедствий'],
    ['g', 10, 16, 'world', 'روز جهانی غذا', 'World Food Day', 'Всемирный день продовольствия'],
    ['g', 10, 24, 'world', 'روز سازمان ملل متحد', 'United Nations Day', 'День Организации Объединённых Наций'],
    ['g', 10, 31, 'world', 'هالووین', 'Halloween', 'Хэллоуин'],
    ['g', 11, 10, 'world', 'روز جهانی علم در خدمت صلح و توسعه', 'World Science Day for Peace and Development', 'Всемирный день науки за мир и развитие'],
    ['g', 11, 20, 'world', 'روز جهانی کودک', 'World Children’s Day', 'Всемирный день ребёнка'],
    ['g', 12, 1, 'world', 'روز جهانی ایدز', 'World AIDS Day', 'Всемирный день борьбы со СПИДом'],
    ['g', 12, 3, 'world', 'روز جهانی افراد دارای معلولیت', 'International Day of Persons with Disabilities', 'Международный день инвалидов'],
    ['g', 12, 10, 'world', 'روز جهانی حقوق بشر', 'Human Rights Day', 'День прав человека'],
    ['g', 12, 25, 'world', 'کریسمس', 'Christmas Day', 'Рождество (католическое)'],
    ['g', 12, 31, 'world', 'شب سال نو میلادی', 'New Year’s Eve', 'Канун Нового года'],

    // Russia
    ['g', 1, 7, 'ru', '', '', 'Рождество Христово'],
    ['g', 2, 23, 'ru', '', '', 'День защитника Отечества'],
    ['g', 4, 12, 'ru', '', '', 'День космонавтики'],
    ['g', 5, 9, 'ru', '', '', 'День Победы'],
    ['g', 6, 1, 'ru', '', '', 'День защиты детей'],
    ['g', 6, 12, 'ru', '', '', 'День России'],
    ['g', 11, 4, 'ru', '', '', 'День народного единства'],
  ]

  const CALENDARS = { p: 'persian', g: 'gregory', h: 'islamic-umalqura' }
  const NAME = { fa: 4, en: 5, ru: 6 }
  const formats = {}
  // Month and day of a date in one of the three calendars.
  function monthDay(date, calendar) {
    formats[calendar] ||= new Intl.DateTimeFormat(`en-u-ca-${CALENDARS[calendar]}-nu-latn`, { month: 'numeric', day: 'numeric' })
    const parts = Object.fromEntries(formats[calendar].formatToParts(date).map((part) => [part.type, Number(part.value)]))
    return [parts.month, parts.day]
  }

  // Names of the occasions that fall on `date`, for a reader of `lang`.
  function on(date, lang) {
    const today = { p: monthDay(date, 'p'), g: monthDay(date, 'g'), h: monthDay(date, 'h') }
    return LIST.filter(([calendar, month, day, audience]) => {
      if (audience === 'ru' ? lang !== 'ru' : audience === 'ir' && lang === 'ru') return false
      return today[calendar][0] === month && today[calendar][1] === day
    }).map((row) => row[NAME[lang] || NAME.en])
  }

  // The next few days that have an occasion: [{ days, date, names }].
  function upcoming(from, lang, limit, horizon = 45) {
    const found = []
    for (let days = 1; days <= horizon && found.length < limit; days++) {
      const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, 12)
      const names = on(date, lang)
      if (names.length) found.push({ days, date, names })
    }
    return found
  }

  root.sadeOccasions = { on, upcoming }
})(this)
