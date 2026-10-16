-- Targeted content-only patch. Back up app_pages before running. Does not change routes or billing.
BEGIN;
DO $guard$
BEGIN
 IF (SELECT COUNT(DISTINCT slug) FROM app_pages WHERE language='en' AND is_active=true AND slug IN ('about_app','privacy_policy','terms_conditions','refund_return','customer_support')) <> 5 THEN
  RAISE EXCEPTION 'Expected 5 active English app pages. Check existing slugs before applying; no content was changed.';
 END IF;
END;
$guard$;
WITH content_updates(slug,language,title,content) AS (VALUES
('about_app','en','About NetPhone','NetPhone LLC

NetPhone is an internet-based communication app for calling supported mobile and landline destinations, sending and receiving fax documents, and managing prepaid service balance.

Calling
Review the destination rate, enter the full international number, keep enough balance and confirm the destination before calling. Contacts, Recent Calls, the in-call keypad and Call Summary help you manage calls. Availability and rates are shown in the app.

Fax
Send PDF, JPG or PNG documents. For receiving, download a Cover Page from YOUR account and share the original PDF with your sender. They must include it first, or second if their service adds its own cover, in the same fax. A clear QR routes the fax to your account. The shared fax destination or a typed Receive ID alone cannot identify the recipient.

Your Cover Page has no fixed expiry and may be reused while your account remains active, until revoked. You may create another cover when needed; this does not automatically cancel earlier covers. Revoke All Covers stops all your old covers, including reused ones. Faxes already in your History remain there.

Wallet & recharge
Use the payment methods currently enabled in your account. Create a current payment order and follow its exact amount, recipient and network instructions. Keep payment references and review transaction status. Never pay using addresses or QR codes from documentation examples.

Fax charges are automatic. Unused Send prepayment is returned after settlement; a Fax Refund entry does not necessarily mean delivery failed. Provider-billed failed attempts may still incur charges.

Help
You will receive feedback within 5 working days.
Email: info@netphoneapp.com
Website: https://netphoneapp.com
User Guide: https://netphoneapp.com/user-guide.html
Fax Guide: https://netphoneapp.com/fax.html

NetPhone is not a replacement for emergency telephone service. Never share your OTP, password or payment secrets.'),
('about_app','bn','NetPhone সম্পর্কে','NetPhone LLC

NetPhone হলো সমর্থিত মোবাইল ও ল্যান্ডলাইনে ইন্টারনেটভিত্তিক কল, ফ্যাক্স পাঠানো/গ্রহণ এবং প্রিপেইড সেবা ব্যালেন্স ব্যবস্থাপনার অ্যাপ।

কল
গন্তব্যের বর্তমান রেট দেখুন, কান্ট্রি কোডসহ সম্পূর্ণ নম্বর লিখুন এবং পর্যাপ্ত ব্যালেন্স রেখে গন্তব্য নিশ্চিত করে কল করুন। Contacts, Recent Calls, কলে Keypad ও Call Summary ব্যবহার করুন। সেবার উপলব্ধতা ও রেট অ্যাপে দেখানো হয়।

ফ্যাক্স
PDF, JPG বা PNG পাঠান। গ্রহণ করতে নিজের অ্যাকাউন্ট থেকে Cover Page ডাউনলোড করে মূল PDF প্রেরককে দিন। একই ফ্যাক্সের প্রথম পাতায় এটি রাখতে হবে; প্রেরকের সেবা নিজস্ব কভার দিলে আপনারটি দ্বিতীয় পাতায় থাকবে। পরিষ্কার QR দিয়ে সার্ভার আপনার অ্যাকাউন্ট চেনে। শেয়ার করা ফ্যাক্স নম্বর বা শুধু Receive ID লিখে প্রাপক শনাক্ত করা যায় না।

অ্যাকাউন্ট সক্রিয় এবং কভার বাতিল না হওয়া পর্যন্ত Cover Page-এর নির্দিষ্ট মেয়াদ নেই; বারবার ব্যবহার করা যায়। প্রয়োজন হলে নতুন কভার বানাতে পারবেন; এতে পুরোনোগুলো নিজে থেকে বাতিল হবে না। Revoke All Covers ব্যবহার করলে আগে ব্যবহৃতসহ সব পুরোনো কভার বন্ধ হবে। History-এর পুরোনো ফ্যাক্স মোছা হবে না।

Wallet ও Recharge
অ্যাকাউন্টে চালু পেমেন্ট পদ্ধতি ব্যবহার করুন। নতুন অর্ডারের অঙ্ক, প্রাপক ও নেটওয়ার্ক হুবহু অনুসরণ করুন। পেমেন্ট রেফারেন্স রাখুন ও ফল দেখুন। নির্দেশিকার ছবির ঠিকানা বা QR দিয়ে পেমেন্ট করবেন না।

ফ্যাক্সের চার্জ স্বয়ংক্রিয়। চূড়ান্ত হিসাবে অতিরিক্ত Send অগ্রিম ফেরত আসে; Fax Refund মানেই ডেলিভারি ব্যর্থ নয়। প্রোভাইডার চার্জ করলে ব্যর্থ চেষ্টাতেও খরচ হতে পারে।

সহায়তা
৫ কর্মদিবসের মধ্যে ফিডব্যাক পাবেন।
Email: info@netphoneapp.com
Website: https://netphoneapp.com
User Guide: https://netphoneapp.com/bn/user-guide.html
Fax Guide: https://netphoneapp.com/bn/fax.html

NetPhone জরুরি টেলিফোন সেবার বিকল্প নয়। OTP, পাসওয়ার্ড বা পেমেন্টের গোপন তথ্য দেবেন না।'),
('about_app','ar','حول NetPhone','NetPhone LLC

NetPhone تطبيق اتصال عبر الإنترنت للمكالمات إلى الهواتف المحمولة والثابتة المدعومة وإرسال الفاكس واستقباله وإدارة رصيد الخدمات المدفوع مسبقاً.

المكالمات
راجع سعر الوجهة وأدخل الرقم الدولي كاملاً مع رمز الدولة، وتأكد من الرصيد والوجهة قبل الاتصال. استخدم جهات الاتصال والمكالمات الأخيرة ولوحة المفاتيح أثناء الاتصال وملخص المكالمة. يعرض التطبيق الأسعار والتوفر.

الفاكس
أرسل PDF أو JPG أو PNG. للاستقبال، نزّل صفحة الغلاف من حسابك وشارك ملف PDF الأصلي مع المرسل. يجب إرفاقها أولاً، أو ثانية إذا أضافت خدمته غلافاً، في الفاكس نفسه. يحدد QR الواضح حسابك؛ ولا يكفي رقم الفاكس المشترك أو كتابة Receive ID وحده لتحديد المستلم.

لا توجد مدة انتهاء محددة للغلاف، ويمكن إعادة استخدامه ما دام الحساب نشطاً وحتى إلغائه. يمكن إنشاء غلاف آخر عند الحاجة دون إلغاء الأغلفة السابقة تلقائياً. يلغي Revoke All Covers جميع أغلفتك السابقة، بما فيها المستخدمة. لا تُحذف الفاكسات الموجودة في السجل.

المحفظة والتعبئة
استخدم طرق الدفع المفعلة لحسابك. أنشئ طلباً جديداً واتبع المبلغ والمستلم والشبكة بدقة. احتفظ بمراجع الدفع وراجع الحالة. لا تدفع باستخدام عناوين أو رموز من صور الدليل.

تُخصم رسوم الفاكس تلقائياً ويُعاد مقدم الإرسال غير المستخدم بعد التسوية. ظهور Fax Refund لا يعني بالضرورة فشل التسليم. قد تُحتسب المحاولات الفاشلة إذا فرض المزود رسوماً.

الدعم
ستتلقى رداً خلال 5 أيام عمل.
Email: info@netphoneapp.com
Website: https://netphoneapp.com
User Guide: https://netphoneapp.com/ar/user-guide.html
Fax Guide: https://netphoneapp.com/ar/fax.html

NetPhone ليس بديلاً لخدمة هاتف الطوارئ. لا تشارك OTP أو كلمة المرور أو بيانات الدفع السرية.'),
('customer_support','en','Customer Support','Need assistance?

We can help with account access, recharge, wallet transactions, calling, fax delivery/routing, document access and technical issues.

Response Time
You will receive feedback within 5 working days.
This is the support response timeframe, not a guarantee that every issue will be fully resolved within that period.

Email: info@netphoneapp.com
Website: https://netphoneapp.com
User Guide: https://netphoneapp.com/user-guide.html

Before contacting support
Refresh the relevant page and check the latest call, fax, payment or transaction status. Avoid repeated calls, fax submissions or payments while the original result is pending.

What to include
Describe the issue and provide the relevant order/transaction/fax reference, app version, date/time and timezone. Provide account-identifying details privately only when required. Hide unrelated personal information in screenshots.

Fax receiving
Ask the sender to include YOUR current Cover Page with a clear, complete QR in the same fax. Put it first, or second if their service adds a cover. Your cover can be reused without a fixed expiry while your account is active, until revoked. A number alone does not identify the receiver.

Security
Never share OTPs, passwords, full card details, CVC, private keys or wallet recovery phrases. Support does not need them.

Thank you for using NetPhone.'),
('customer_support','bn','গ্রাহক সহায়তা','সহায়তা প্রয়োজন?

অ্যাকাউন্ট, Recharge, Wallet লেনদেন, কল, ফ্যাক্স ডেলিভারি/রাউটিং, ডকুমেন্ট খোলা ও প্রযুক্তিগত সমস্যায় সাহায্য নিন।

উত্তরের সময়
৫ কর্মদিবসের মধ্যে ফিডব্যাক পাবেন।
এটি সাপোর্টের উত্তর দেওয়ার সময়; সব সমস্যা এই সময়ের মধ্যেই পুরোপুরি সমাধান হওয়ার নিশ্চয়তা নয়।

Email: info@netphoneapp.com
Website: https://netphoneapp.com
User Guide: https://netphoneapp.com/bn/user-guide.html

যোগাযোগের আগে
সংশ্লিষ্ট পেজ Refresh করে কল, ফ্যাক্স, পেমেন্ট বা লেনদেনের সর্বশেষ অবস্থা দেখুন। আগের ফল প্রক্রিয়াধীন থাকলে একই কল, ফ্যাক্স বা পেমেন্ট বারবার করবেন না।

যা জানাবেন
সমস্যার বিবরণ, অর্ডার/লেনদেন/ফ্যাক্স রেফারেন্স, অ্যাপ সংস্করণ, তারিখ/সময় ও টাইমজোন দিন। প্রয়োজন হলেই অ্যাকাউন্টের পরিচয় ব্যক্তিগতভাবে দিন। স্ক্রিনশটে অপ্রাসঙ্গিক ব্যক্তিগত তথ্য ঢাকুন।

ফ্যাক্স গ্রহণ
প্রেরককে নিজের বর্তমান Cover Page-এর সম্পূর্ণ পরিষ্কার QR একই ফ্যাক্সে প্রথমে রাখতে বলুন; প্রেরকের সেবা কভার দিলে দ্বিতীয়তে রাখুন। অ্যাকাউন্ট সক্রিয় এবং কভার বাতিল না হলে নির্দিষ্ট মেয়াদ ছাড়া বারবার ব্যবহার করা যায়। শুধু নম্বর দিয়ে প্রাপক শনাক্ত হয় না।

নিরাপত্তা
OTP, পাসওয়ার্ড, সম্পূর্ণ কার্ড তথ্য, CVC, private key বা recovery phrase দেবেন না। সাপোর্টের এগুলো প্রয়োজন হয় না।

NetPhone ব্যবহারের জন্য ধন্যবাদ।'),
('customer_support','ar','دعم العملاء','هل تحتاج إلى مساعدة؟

نساعد في الوصول للحساب والتعبئة ومعاملات المحفظة والمكالمات وتسليم الفاكس وتوجيهه والوصول للمستندات والمشكلات التقنية.

وقت الرد
ستتلقى رداً خلال 5 أيام عمل.
هذا إطار الرد من الدعم، وليس ضماناً بحل كل مشكلة بالكامل خلال هذه المدة.

Email: info@netphoneapp.com
Website: https://netphoneapp.com
User Guide: https://netphoneapp.com/ar/user-guide.html

قبل التواصل
حدّث الصفحة وراجع آخر حالة للمكالمة أو الفاكس أو الدفع أو المعاملة. تجنب تكرار المكالمات أو إرسال الفاكس أو الدفع أثناء انتظار النتيجة الأصلية.

المعلومات المطلوبة
اذكر وصف المشكلة ومرجع الطلب أو المعاملة أو الفاكس وإصدار التطبيق والتاريخ والوقت والمنطقة الزمنية. قدّم معرفات الحساب بشكل خاص عند الحاجة فقط، واحجب المعلومات الشخصية غير المرتبطة من الصور.

استقبال الفاكس
اطلب من المرسل إرفاق صفحة غلافك الحالية مع QR واضح وكامل في الفاكس نفسه، أولاً أو ثانية إذا أضافت خدمته غلافاً. يمكن إعادة استخدامها دون انتهاء محدد ما دام الحساب نشطاً وحتى الإلغاء. الرقم وحده لا يحدد المستلم.

الأمان
لا تشارك OTP أو كلمات المرور أو بيانات البطاقة الكاملة أو CVC أو المفاتيح الخاصة أو عبارات الاسترداد. لا يحتاجها الدعم.

شكراً لاستخدام NetPhone.'),
('privacy_policy','en','Privacy Policy','NETPHONE LLC / POLICIES
Privacy Policy

Updated 16 October 2026. Contact: info@netphoneapp.com.

Scope

This policy explains how NetPhone LLC collects, uses, protects and shares information for the NetPhone app, website and related services.

Information we may collect

Mobile number, user ID, account status, preferences, OTP request and verification records.

Destination, call time, duration, status, rate, cost and technical routing data. Contacts are used only when you grant permission and use contact features.

Wallet balance, recharge requests, transaction references, verification/approval status, device identifiers, app version, IP address, diagnostics and security logs.

Fax documents, Cover Page routing information, page counts, status and billing records needed to provide fax services, plus information you send to support.

How we use information

Provide registration, verification, calling, fax, rates, balance and recharge features; prevent fraud, abuse and unauthorized access; troubleshoot and improve reliability; respond to support requests and comply with applicable law.

Permissions

The app may request microphone access for calls, contacts access for contact selection, notifications for service alerts and document access through the system picker for fax files. Manage permissions in device settings.

Service providers

We may share limited information with communications carriers, OTP providers, hosting providers, transaction processors and technical providers as necessary to operate NetPhone. We do not sell personal information.

Retention and security

We retain information as reasonably necessary for service delivery, fraud prevention, dispute resolution and legal compliance. We use reasonable technical and organizational safeguards, but no internet service guarantees absolute security.

Account deletion

Initiate deletion in the app or through the account deletion page. Some records may be retained for legal, security or financial reconciliation obligations.

Children

NetPhone is not directed to children under 13. Contact: info@netphoneapp.com.

Support · Company · Delete Account

Reusable fax cover privacy
A Cover Page QR can route future incoming faxes to its owner while active, until revoked; it does not sign in to an account or authorize document downloads. Share the original PDF only with trusted senders. If it is exposed, use Revoke All Covers, create a new cover and send the replacement to your contacts.'),
('privacy_policy','bn','গোপনীয়তা নীতি','NETPHONE LLC / নীতিমালা
গোপনীয়তা নীতি

হালনাগাদ: ১৬ অক্টোবর ২০২৬। যোগাযোগ: info@netphoneapp.com।

আওতা

এই নীতি NetPhone অ্যাপ, ওয়েবসাইট ও সংশ্লিষ্ট সেবায় NetPhone LLC কীভাবে তথ্য সংগ্রহ, ব্যবহার, সুরক্ষা ও শেয়ার করে তা ব্যাখ্যা করে।

যে তথ্য সংগ্রহ হতে পারে

মোবাইল নম্বর, ইউজার ID, অ্যাকাউন্টের অবস্থা, পছন্দ, OTP আবেদন ও যাচাইয়ের রেকর্ড।

গন্তব্য, কলের সময়/দৈর্ঘ্য, অবস্থা, রেট, খরচ ও প্রযুক্তিগত রাউটিং তথ্য। অনুমতি দিয়ে কন্টাক্ট ফিচার ব্যবহার করলেই Contacts ব্যবহৃত হয়।

Wallet ব্যালেন্স, Recharge আবেদন, লেনদেনের রেফারেন্স, যাচাই/অনুমোদনের অবস্থা, ডিভাইস পরিচয়, অ্যাপ সংস্করণ, IP, ডায়াগনস্টিক ও নিরাপত্তা লগ।

ফ্যাক্স সেবা দিতে প্রয়োজনীয় ডকুমেন্ট, Cover Page রাউটিং তথ্য, পৃষ্ঠা সংখ্যা, অবস্থা ও বিলিং রেকর্ড এবং সাপোর্টে দেওয়া তথ্য।

তথ্যের ব্যবহার

নিবন্ধন, যাচাই, কল, ফ্যাক্স, রেট, ব্যালেন্স ও Recharge চালানো; প্রতারণা, অপব্যবহার ও অননুমোদিত প্রবেশ ঠেকানো; সমস্যা নির্ণয় ও নির্ভরযোগ্যতা বাড়ানো; সহায়তা ও প্রযোজ্য আইন পালন।

অনুমতি

অ্যাপ কলের জন্য মাইক্রোফোন, কন্টাক্ট বাছতে Contacts, সতর্কতার জন্য Notifications এবং ফ্যাক্স ফাইল বাছতে system picker-এর প্রবেশ চাইতে পারে। ডিভাইস Settings থেকে অনুমতি নিয়ন্ত্রণ করুন।

সেবাদাতা

NetPhone চালাতে প্রয়োজনমতো যোগাযোগ ক্যারিয়ার, OTP, হোস্টিং, পেমেন্ট প্রসেসর ও প্রযুক্তিগত সেবাদাতার সঙ্গে সীমিত তথ্য শেয়ার হতে পারে। আমরা ব্যক্তিগত তথ্য বিক্রি করি না।

সংরক্ষণ ও নিরাপত্তা

সেবা, প্রতারণা প্রতিরোধ, বিরোধ নিষ্পত্তি ও আইন মানতে যৌক্তিকভাবে যতদিন প্রয়োজন তথ্য রাখা হয়। যুক্তিসংগত প্রযুক্তিগত ও সাংগঠনিক সুরক্ষা থাকে, তবে কোনো ইন্টারনেট সেবায় শতভাগ নিরাপত্তার নিশ্চয়তা নেই।

অ্যাকাউন্ট মোছা

অ্যাপ বা Delete Account পেজ থেকে আবেদন করুন। আইন, নিরাপত্তা বা আর্থিক হিসাব মেলানোর বাধ্যবাধকতায় কিছু রেকর্ড রাখা হতে পারে।

শিশু

NetPhone ১৩ বছরের কম বয়সী শিশুদের জন্য নয়। যোগাযোগ: info@netphoneapp.com।

সহায়তা · কোম্পানি · অ্যাকাউন্ট মুছুন

পুনর্ব্যবহারযোগ্য ফ্যাক্স কভারের গোপনীয়তা
সক্রিয় Cover Page-এর QR বাতিল না হওয়া পর্যন্ত ভবিষ্যৎ ফ্যাক্স মালিকের অ্যাকাউন্টে পাঠাতে পারে; এটি লগইন বা ডকুমেন্ট ডাউনলোডের অনুমতি দেয় না। মূল PDF শুধু বিশ্বস্ত প্রেরককে দিন। ফাঁস হলে Revoke All Covers দিয়ে নতুন কভার বানিয়ে সংশ্লিষ্ট প্রেরকদের দিন।'),
('privacy_policy','ar','سياسة الخصوصية','NETPHONE LLC / السياسات
سياسة الخصوصية

آخر تحديث: 16 أكتوبر 2026. للتواصل: info@netphoneapp.com.

النطاق

توضح هذه السياسة كيفية جمع NetPhone LLC للمعلومات واستخدامها وحمايتها ومشاركتها لتطبيق NetPhone والموقع والخدمات المرتبطة.

المعلومات التي قد نجمعها

رقم الهاتف ومعرّف المستخدم وحالة الحساب والتفضيلات وسجلات طلب OTP والتحقق.

الوجهة ووقت المكالمة ومدتها وحالتها وسعرها وتكلفتها وبيانات التوجيه التقنية. تُستخدم جهات الاتصال عند منح الإذن واستخدام ميزاتها فقط.

رصيد المحفظة وطلبات التعبئة ومراجع المعاملات وحالة التحقق أو الموافقة ومعرفات الجهاز وإصدار التطبيق وعنوان IP وسجلات التشخيص والأمان.

مستندات الفاكس ومعلومات توجيه صفحة الغلاف وعدد الصفحات والحالة وسجلات الفوترة اللازمة لتوفير الخدمة، والمعلومات المرسلة للدعم.

كيفية استخدام المعلومات

لتوفير التسجيل والتحقق والمكالمات والفاكس والأسعار والرصيد والتعبئة، ومنع الاحتيال والإساءة والدخول غير المصرح، وحل المشكلات وتحسين الاعتمادية والرد على الدعم والامتثال للقانون.

الأذونات

قد يطلب التطبيق الميكروفون للمكالمات وجهات الاتصال للاختيار والإشعارات لتنبيهات الخدمة والوصول للمستندات عبر منتقي النظام لملفات الفاكس. أدر الأذونات من إعدادات الجهاز.

مزودو الخدمات

قد نشارك معلومات محدودة مع شركات الاتصالات ومزودي OTP والاستضافة ومعالجي المعاملات والمزودين التقنيين حسب الحاجة لتشغيل NetPhone. لا نبيع المعلومات الشخصية.

الاحتفاظ والأمان

نحتفظ بالمعلومات بالقدر اللازم بشكل معقول لتقديم الخدمة ومنع الاحتيال وحل النزاعات والامتثال القانوني. نستخدم ضمانات تقنية وتنظيمية معقولة، لكن لا تضمن خدمة إنترنت أماناً مطلقاً.

حذف الحساب

ابدأ الحذف من التطبيق أو صفحة حذف الحساب. قد تُحتفظ ببعض السجلات للالتزامات القانونية أو الأمنية أو التسوية المالية.

الأطفال

NetPhone غير موجه للأطفال دون 13 عاماً. للتواصل: info@netphoneapp.com.

الدعم · الشركة · حذف الحساب

خصوصية غلاف الفاكس القابل لإعادة الاستخدام
يمكن لـQR الغلاف النشط توجيه فاكسات مستقبلية لحساب مالكه حتى إلغائه؛ ولا يسجّل الدخول أو يسمح بتنزيل المستندات. شارك PDF الأصلي مع المرسلين الموثوقين فقط. إذا انكشف، ألغِ كل الأغلفة وأنشئ بديلاً وأرسله لجهاتك.'),
('terms_conditions','en','Terms & Conditions','NETPHONE LLC / POLICIES
Terms & Conditions

Updated 16 October 2026. Contact: info@netphoneapp.com.

Service

NetPhone LLC provides internet-based calling to supported mobile and landline destinations and fax services through NetPhone. Availability, rates and quality may change.

Acceptable use

You may not use NetPhone for fraud, harassment, threats, impersonation, unlawful communications, automated abuse or attempts to bypass security.

Rates and balance

Rates may vary by destination, network, route, tax and provider cost. Recharge requests may require verification. Fax Send may use advance payment followed by settlement; unused advance is returned to the wallet. New received faxes are charged automatically. An attempt can incur a charge when the provider bills it.

Fax routing

For automatic receipt, the sender must include the recipient’s valid, non-revoked Cover Page with a readable QR in the same fax. Covers have no fixed expiry and may be reused while the account remains active, until revoked. Creating another cover does not cancel older covers. Revoked covers remain invalid. Missing or invalid covers require support review and may not reach the user automatically.

Emergency calls

NetPhone is not a replacement for traditional emergency telephone service.

Suspension

We may limit or suspend access for fraud, abuse, security risks, legal requirements or material violations.

Support · Company · Delete Account

User responsibility and limits permitted by law
Before submitting a call or fax, verify the destination, recipient, document, page order and instructions. You are responsible for having permission to send the content and for protecting your account and reusable Cover Page. For receiving, share the correct, non-revoked Cover Page and ensure its complete QR is attached to every incoming fax.

To the extent permitted by applicable law, NetPhone LLC is not responsible for charges, misdelivery, disclosure, missed deadlines or other losses caused solely by your incorrect destination, wrong document, missing/unclear QR, use of a revoked cover, unauthorized sharing of your routing cover or duplicate submission. Successful transmission does not guarantee that the intended person has read or accepted the document.

This clause does not exclude liability that cannot lawfully be excluded, including applicable statutory consumer rights. It does not prevent review of duplicate charges or confirmed company billing errors. Contact support if something went wrong.'),
('terms_conditions','bn','শর্তাবলি','NETPHONE LLC / নীতিমালা
শর্তাবলি

হালনাগাদ: ১৬ অক্টোবর ২০২৬। যোগাযোগ: info@netphoneapp.com।

সেবা

NetPhone LLC, NetPhone-এর মাধ্যমে সমর্থিত মোবাইল ও ল্যান্ডলাইনে ইন্টারনেটভিত্তিক কল ও ফ্যাক্স সেবা দেয়। উপলব্ধতা, রেট ও মান বদলাতে পারে।

গ্রহণযোগ্য ব্যবহার

প্রতারণা, হয়রানি, হুমকি, পরিচয় জালিয়াতি, বেআইনি যোগাযোগ, স্বয়ংক্রিয় অপব্যবহার বা নিরাপত্তা পাশ কাটাতে NetPhone ব্যবহার করা যাবে না।

রেট ও ব্যালেন্স

গন্তব্য, নেটওয়ার্ক, রুট, কর ও প্রোভাইডার খরচ অনুযায়ী রেট বদলাতে পারে। Recharge যাচাই লাগতে পারে। Fax Send-এ অগ্রিম কেটে চূড়ান্ত হিসাব করা হতে পারে; অতিরিক্ত অগ্রিম Wallet-এ ফেরত যায়। নতুন Receive স্বয়ংক্রিয়ভাবে চার্জ হয়। প্রোভাইডার চার্জ করলে ব্যর্থ চেষ্টাতেও চার্জ হতে পারে।

ফ্যাক্স রাউটিং

স্বয়ংক্রিয় গ্রহণে একই ফ্যাক্সে প্রাপকের বৈধ, বাতিল না হওয়া Cover Page-এর পাঠযোগ্য QR থাকতে হবে। অ্যাকাউন্ট সক্রিয় এবং কভার বাতিল না হলে নির্দিষ্ট মেয়াদ নেই; বারবার ব্যবহার করা যায়। নতুন কভার বানালে পুরোনোগুলো বাতিল হয় না। বাতিল কভার অবৈধ থাকে। কভার অনুপস্থিত/অবৈধ হলে সাপোর্ট পর্যালোচনা লাগে এবং ইউজারের কাছে স্বয়ংক্রিয়ভাবে নাও পৌঁছাতে পারে।

জরুরি কল

NetPhone প্রচলিত জরুরি টেলিফোন সেবার বিকল্প নয়।

স্থগিতকরণ

প্রতারণা, অপব্যবহার, নিরাপত্তা ঝুঁকি, আইনগত প্রয়োজন বা গুরুতর শর্তভঙ্গে সেবা সীমিত বা স্থগিত হতে পারে।

সহায়তা · কোম্পানি · অ্যাকাউন্ট মুছুন

ইউজারের দায়িত্ব ও আইনসম্মত দায়সীমা
কল বা ফ্যাক্স দেওয়ার আগে গন্তব্য, প্রাপক, ডকুমেন্ট, পাতার ক্রম ও নিয়ম যাচাই করুন। পাঠানোর অনুমতি থাকা এবং নিজের অ্যাকাউন্ট ও পুনর্ব্যবহারযোগ্য Cover Page সুরক্ষার দায়িত্ব আপনার। গ্রহণের জন্য সঠিক, বাতিল না হওয়া Cover Page দিন এবং প্রতিটি incoming ফ্যাক্সে সম্পূর্ণ QR রাখুন।

প্রযোজ্য আইন যতটুকু অনুমোদন করে, কেবল ইউজারের ভুল গন্তব্য, ভুল ডকুমেন্ট, বাদ দেওয়া/অস্পষ্ট QR, বাতিল কভার, অনুমতিহীনভাবে routing cover শেয়ার বা দ্বৈত সাবমিশনের কারণে চার্জ, ভুল ডেলিভারি, তথ্য প্রকাশ, সময়সীমা মিস বা অন্য ক্ষতির জন্য NetPhone LLC দায়ী নয়। সফল ট্রান্সমিশন মানেই নির্দিষ্ট ব্যক্তি ডকুমেন্ট পড়েছেন বা গ্রহণ করেছেন—এমন নিশ্চয়তা নয়।

আইনে বাদ দেওয়া যায় না এমন দায় বা প্রযোজ্য ভোক্তা অধিকার এই শর্তে বাদ দেওয়া হয় না। দ্বৈত চার্জ বা কোম্পানির নিশ্চিত বিলিং ভুলের পর্যালোচনা বন্ধ হয় না। সমস্যা হলে সাপোর্টে জানান।'),
('terms_conditions','ar','الشروط والأحكام','NETPHONE LLC / السياسات
الشروط والأحكام

آخر تحديث: 16 أكتوبر 2026. للتواصل: info@netphoneapp.com.

الخدمة

تقدم NetPhone LLC عبر NetPhone المكالمات عبر الإنترنت للهواتف المدعومة وخدمات الفاكس. قد يتغير التوفر والأسعار والجودة.

الاستخدام المقبول

لا يجوز استخدام NetPhone للاحتيال أو المضايقة أو التهديد أو الانتحال أو الاتصالات غير القانونية أو الإساءة الآلية أو تجاوز الأمان.

الأسعار والرصيد

قد تختلف الأسعار حسب الوجهة والشبكة والمسار والضرائب وتكلفة المزود. قد تتطلب التعبئة تحققاً. قد يُخصم مقدم لإرسال الفاكس ثم تسويته وإعادة غير المستخدم للمحفظة. تُخصم رسوم الفاكس المستلم الجديد تلقائياً وقد تُفرض رسوم على المحاولة إذا احتسبها المزود.

توجيه الفاكس

للاستقبال التلقائي يجب إرفاق صفحة غلاف المستلم الصالحة وغير الملغاة مع QR مقروء في الفاكس نفسه. لا توجد مدة انتهاء محددة للغلاف، ويمكن إعادة استخدامه ما دام الحساب نشطاً وحتى الإلغاء. إنشاء غلاف آخر لا يلغي الأغلفة السابقة. يظل الغلاف الملغى غير صالح. يتطلب الغلاف المفقود أو غير الصالح مراجعة الدعم وقد لا يصل تلقائياً للمستخدم.

مكالمات الطوارئ

NetPhone ليس بديلاً لخدمة هاتف الطوارئ التقليدية.

التعليق

قد نحد الوصول أو نعلقه بسبب الاحتيال أو الإساءة أو مخاطر الأمان أو المتطلبات القانونية أو المخالفات الجوهرية.

الدعم · الشركة · حذف الحساب

مسؤولية المستخدم وحدود المسؤولية المسموح بها قانوناً
تحقق قبل المكالمة أو الفاكس من الوجهة والمستلم والمستند وترتيب الصفحات والتعليمات. أنت مسؤول عن الإذن بإرسال المحتوى وحماية حسابك وصفحة الغلاف القابلة لإعادة الاستخدام. للاستقبال، شارك الغلاف الصحيح غير الملغى وأرفق QR كاملاً بكل فاكس وارد.

بالقدر الذي يسمح به القانون، لا تتحمل NetPhone LLC مسؤولية الرسوم أو التسليم الخاطئ أو الإفصاح أو تفويت المواعيد أو الخسائر الناجمة حصراً عن إدخال المستخدم وجهة خاطئة أو مستند خاطئ أو QR مفقود أو غير واضح أو غلاف ملغى أو مشاركة غلاف التوجيه دون إذن أو إرسال مكرر. نجاح الإرسال لا يضمن أن الشخص المقصود قرأ المستند أو قبله.

لا يستبعد هذا الشرط أي مسؤولية لا يجوز استبعادها قانوناً، بما فيها حقوق المستهلك النظامية المطبقة، ولا يمنع مراجعة الرسوم المكررة أو أخطاء فوترة الشركة المؤكدة. تواصل مع الدعم عند حدوث مشكلة.'),
('refund_return','en','Refund & Return','NETPHONE LLC / POLICIES
Refund Policy

Updated 16 October 2026. Contact: info@netphoneapp.com.

Digital services

NetPhone LLC provides digital communication services; there are no physical goods to return.

Eligible review requests

We may review duplicate charges, confirmed technical billing errors or approved recharges that were not credited.

Generally non-refundable

Consumed service credit, completed calls/faxes, promotional credit and charges caused by incorrect destination entry are generally non-refundable unless required by law.

Fax prepayment adjustment

Fax Refund in the wallet can be the return of unused Send prepayment after settlement. It does not by itself mean a fax failed, and it is distinct from a request to refund a recharge payment.

Request a review

Email info@netphoneapp.com with your transaction reference and account details privately as needed. Never send OTPs, passwords, private keys or recovery phrases. You will receive feedback within 5 working days.

Support · Company · Delete Account

Incorrect destinations, wrong documents or duplicate submissions caused by the user do not automatically qualify for reimbursement. Review is subject to the Terms and applicable law; statutory rights and confirmed company billing errors are not excluded.'),
('refund_return','bn','রিফান্ড ও ফেরত','NETPHONE LLC / নীতিমালা
রিফান্ড নীতি

হালনাগাদ: ১৬ অক্টোবর ২০২৬। যোগাযোগ: info@netphoneapp.com।

ডিজিটাল সেবা

NetPhone LLC ডিজিটাল যোগাযোগ সেবা দেয়; ফেরত দেওয়ার মতো কোনো ভৌত পণ্য নেই।

পর্যালোচনাযোগ্য আবেদন

দ্বৈত চার্জ, নিশ্চিত প্রযুক্তিগত বিলিং ত্রুটি বা অনুমোদিত Recharge যোগ না হলে পর্যালোচনা করা হতে পারে।

সাধারণত ফেরতযোগ্য নয়

ব্যবহৃত সেবা ব্যালেন্স, সম্পন্ন কল/ফ্যাক্স, প্রচারমূলক ব্যালেন্স ও ভুল গন্তব্যের চার্জ সাধারণত ফেরতযোগ্য নয়, আইন বাধ্য করলে ব্যতিক্রম।

ফ্যাক্স অগ্রিমের সমন্বয়

Wallet-এর Fax Refund চূড়ান্ত হিসাবে অতিরিক্ত Send অগ্রিম ফেরত হতে পারে। এটি নিজে থেকে ফ্যাক্স ব্যর্থ বোঝায় না এবং Recharge পেমেন্ট ফেরতের আবেদন থেকে আলাদা।

পর্যালোচনার আবেদন

লেনদেনের রেফারেন্স ও প্রয়োজনীয় অ্যাকাউন্টের তথ্য ব্যক্তিগতভাবে info@netphoneapp.com-এ দিন। OTP, পাসওয়ার্ড, private key বা recovery phrase দেবেন না। ৫ কর্মদিবসের মধ্যে ফিডব্যাক পাবেন।

সহায়তা · কোম্পানি · অ্যাকাউন্ট মুছুন

ইউজারের ভুল গন্তব্য, ভুল ডকুমেন্ট বা দ্বৈত সাবমিশন স্বয়ংক্রিয়ভাবে টাকা ফেরতের অধিকার দেয় না। শর্তাবলি ও প্রযোজ্য আইন অনুযায়ী পর্যালোচনা হবে; আইনগত অধিকার ও কোম্পানির নিশ্চিত বিলিং ভুল বাদ নয়।'),
('refund_return','ar','الاسترداد والإرجاع','NETPHONE LLC / السياسات
سياسة الاسترداد

آخر تحديث: 16 أكتوبر 2026. للتواصل: info@netphoneapp.com.

الخدمات الرقمية

تقدم NetPhone LLC خدمات اتصال رقمية ولا توجد بضائع مادية لإرجاعها.

طلبات المراجعة المؤهلة

قد نراجع الخصومات المكررة وأخطاء الفوترة التقنية المؤكدة والتعبئات المعتمدة التي لم تُضف.

غير قابلة للاسترداد عموماً

الرصيد المستخدم والمكالمات أو الفاكسات المكتملة والرصيد الترويجي ورسوم الوجهة الخاطئة غير قابلة للاسترداد عموماً إلا إذا ألزم القانون.

تسوية مقدم الفاكس

قد يكون Fax Refund بالمحفظة إعادة مقدم الإرسال غير المستخدم بعد التسوية. لا يعني وحده فشل الفاكس ويختلف عن طلب استرداد دفعة تعبئة.

طلب مراجعة

راسل info@netphoneapp.com بمرجع المعاملة وبيانات الحساب اللازمة بشكل خاص. لا ترسل OTP أو كلمات مرور أو مفاتيح خاصة أو عبارات استرداد. ستتلقى رداً خلال 5 أيام عمل.

الدعم · الشركة · حذف الحساب

لا تؤهل الوجهات أو المستندات الخاطئة أو الإرسالات المكررة التي يسببها المستخدم للاسترداد تلقائياً. تخضع المراجعة للشروط والقانون المطبق، ولا تُستبعد الحقوق النظامية أو أخطاء فوترة الشركة المؤكدة.'))
UPDATE app_pages p SET title=u.title,content=u.content,updated_at=NOW()
FROM content_updates u WHERE p.slug=u.slug AND p.language=u.language
 AND (p.title IS DISTINCT FROM u.title OR p.content IS DISTINCT FROM u.content);
SELECT slug,language,title FROM app_pages WHERE slug IN ('about_app','privacy_policy','terms_conditions','refund_return','customer_support') ORDER BY slug,language;


-- Targeted metadata update: preserve existing IDs, hashes, revocation and first-use audit.
-- Previously used/expired but non-revoked covers become reusable too.
-- Apply with the matching faxCover.service.js and faxPlatform.service.js.

UPDATE netphone_fax_cover_codes SET expires_at='infinity'::timestamptz
WHERE revoked_at IS NULL AND expires_at IS DISTINCT FROM 'infinity'::timestamptz;
SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at='infinity'::timestamptz) AS permanent_non_revoked,
 COUNT(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked_preserved
FROM netphone_fax_cover_codes;
COMMIT;
