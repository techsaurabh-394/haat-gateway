<p align="center"><img src="assets/hero.svg" alt="Haat: पर्सनल AI एजेंट का अनुरोध गेटवे पर आपकी मंज़ूरी का इंतज़ार करता है, फिर ONDC विक्रेताओं तक पहुँचता है" width="100%"></p>

# Haat गेटवे

[English](README.md) | **हिंदी**

**Haat** (हाट) पर्सनल AI एजेंट्स को भारत के ओपन कॉमर्स नेटवर्क **ONDC** के विक्रेताओं से खरीदारी करने देता है। आप जैसे लिखते हैं, वह वैसे ही समझता है, और **आपकी "हाँ" के बिना कोई ऑर्डर नहीं होता।**

एक तरफ़ यह [Personal Agent Protocol](https://personalagentprotocol.org/) ("Poppy") की "Company" है, और दूसरी तरफ़ ONDC/Beckn का buyer app। पर्सनल एजेंट Poppy बोलते हैं, लाखों भारतीय विक्रेता Beckn बोलते हैं। Haat दोनों के बीच अनुवाद करता है।

```text
"do kilo aata aur 1 litre doodh"  ->  2 x गेहूं का आटा 1 kg, 1 x टोंड दूध 1 L, Kashi Kirana Store, लंका
                                   ->  "कुल ₹197, डिलीवरी पर भुगतान। मंज़ूरी दें?"  ->  हाँ  ->  ऑर्डर KKS-1001 (सिर्फ़ एक बार)
```

## यह क्यों

6 अक्टूबर 2026 को Sierra और Meta ने Poppy की घोषणा की: पर्सनल एजेंट्स के व्यापारों के साथ काम करने का एक खुला मानक। छोटे भारतीय विक्रेता यह नया प्रोटोकॉल खुद लागू नहीं करेंगे, इसलिए बिना पुल के वे उन एजेंट्स को दिखेंगे ही नहीं जिनका उनके ग्राहक इस्तेमाल करते हैं। ONDC के पास पहले से मशीन से पढ़े जा सकने वाले कैटलॉग और ऑर्डर हैं। Haat दोनों को जोड़ता है।

## अभी क्या काम करता है

- **Poppy draft 0.3:** discovery, Session की पूरी जाँच, बातचीत (events, cursor, live streaming), sign-in (OAuth, PKCE), काम जो नहीं दिए जाते और feedback (section 9)।
- **मंज़ूरी का दरवाज़ा:** हर ऑर्डर और रद्दीकरण के लिए आप सटीक शर्तें मंज़ूर करते हैं। ऑर्डर ज़्यादा से ज़्यादा एक बार होता है, सर्वर restart के बाद भी।
- **हिंग्लिश, हिंदी और दस और भारतीय भाषाएँ:** "2 kilo aata", "दो किलो आटा", "aadha kilo paneer", "12 ande"। 130 किराना उत्पाद; भोजपुरी, मराठी, बंगाली, तमिल, तेलुगु, गुजराती, कन्नड़, मलयालम, पंजाबी और ओड़िया, हर भाषा अपनी लिपि में और लैटिन अक्षरों में। **सिर्फ़ हिंदी हाथ से लिखी गई है; बाकी भाषाओं का डेटा मशीन ने बनाया है और किसी मातृभाषी ने जाँचा नहीं है**, इसलिए कुछ शब्द ग़लत हो सकते हैं। जाँच में मदद का स्वागत है ([docs/lexicon.md](docs/lexicon.md))।
- **टोकरी:** सबसे कम बर्बादी वाले पैक, और वह विक्रेता जिसके पास सबसे ज़्यादा सामान हो।
- **ONDC buyer app:** Ed25519 हस्ताक्षर, registry lookup, search, select, init, confirm, status, cancel, और ONDC onboarding की तैयारी।
- **स्थानीय नेटवर्क:** नकली registry, gateway और वाराणसी के तीन विक्रेता, ताकि सब कुछ ऑफ़लाइन चले।

**जाँचा गया:** 126 स्वचालित टेस्ट, सभी पास। Poppy के **आधिकारिक validator** में 99 जाँचें पास, 0 असफल, 0 चेतावनी ([परिणाम](docs/conformance/official-validator-results.txt))। **अभी नहीं:** असली ONDC से जुड़ाव (इसके लिए आपकी कानूनी इकाई और ONDC की मंज़ूरी चाहिए), असली SMS OTP।

## एक मिनट में चलाएँ

```bash
git clone https://github.com/techsaurabh-394/haat-gateway.git
cd haat-gateway
npm install
npm run demo       # टर्मिनल में आप ऑर्डर मंज़ूर करते हैं
```

Node.js 22.18 या नया चाहिए। Docker से: `docker compose up --build`।

## योगदान करें

ज़्यादातर योगदान के लिए TypeScript जानना ज़रूरी नहीं। आप बता सकते हैं कि आपके शहर में *प्याज़* कैसे लिखा जाता है, नया domain pack जोड़ सकते हैं, या docs सुधार सकते हैं। शुरुआत [CONTRIBUTING.md](CONTRIBUTING.md) और [`good first issue`](https://github.com/techsaurabh-394/haat-gateway/labels/good%20first%20issue) से करें।

## लेखक

**सौरभ पाठक**, वाराणसी के AI इंजीनियर और फ़ुल-स्टैक डेवलपर। [GitHub](https://github.com/techsaurabh-394) · [LinkedIn](https://linkedin.com/in/tech-saurabh) · [Blog](https://mernstackdev.com)

अगर Haat आपके काम आए, तो [एक कॉफ़ी पिला सकते हैं](https://buymeacoffee.com/saurabhdev)।

Haat स्वतंत्र प्रोजेक्ट है; ONDC, Sierra, Meta या Personal Agent Protocol प्रोजेक्ट से इसका कोई संबंध नहीं है। [MIT License](LICENSE)।

> यह अनुवाद Claude ने किया है। किसी हिंदी भाषी से समीक्षा करवाना बाकी है; सुधार के PR का स्वागत है।
