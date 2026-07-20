import { useLanguage } from "../context/LanguageContext";

const NAMMADVG_URL = "https://nammadvg.com";

interface Official {
  name: string;
  nameKn: string;
  designation: string;
  phone: string;
}

interface Department {
  id: string;
  name: string;
  scope: string;
  helpline: string;
  email: string;
  office: string;
  officials: Official[];
}

// Source: Namma Davanagere — Connect Officials (Gandhinagar-1 ward directory).
const CITY_OFFICIALS: Department[] = [
  {
    id: "health",
    name: "Health and Sanitation",
    scope: "Garbage, Sweeping, Dustbin, Septic Tank, Toilet, Mosquito control",
    helpline: "8277234444",
    email: "commissioner_davanagere@yahoo.com",
    office: "City Corporation, Davanagere",
    officials: [
      { name: "Mohamed Tanvir", nameKn: "ಮೊಹಮ್ಮದ್ ತನ್ವೀರ್", designation: "Health Inspector", phone: "7022474799" },
      { name: "Shivrajappa B", nameKn: "ಶಿವರಾಜಪ್ಪ ಬಿ", designation: "Sanitary Supervisor", phone: "8867867600" },
    ],
  },
  {
    id: "water",
    name: "Water Supply Department",
    scope: "Water supply, Leakage, Dirty water, New connection, Borewell, Meter",
    helpline: "8277234444",
    email: "commissioner_davanagere@yahoo.com",
    office: "City Corporation, Davanagere",
    officials: [
      { name: "Veeresh B", nameKn: "ವೀರೇಶ್ ಬಿ", designation: "Waterman", phone: "8880485103" },
      { name: "Veeresh B", nameKn: "ವೀರೇಶ್ ಬಿ", designation: "Water Supply Maintenance", phone: "8880485103" },
      { name: "Sunil Kumar C", nameKn: "ಸುನಿಲ್ ಕುಮಾರ್ ಸಿ", designation: "Water Supply Bill Collector", phone: "7676042048" },
    ],
  },
  {
    id: "engineering",
    name: "Engineering Department",
    scope: "Pothole, Footpath, Drainage, Manhole, Water stagnation, Debris",
    helpline: "8277234444",
    email: "commissioner_davanagere@yahoo.com",
    office: "City Corporation, Davanagere",
    officials: [
      { name: "Prathibha B R", nameKn: "ಪ್ರತಿಭಾ ಬಿ ಆರ್", designation: "Junior Engineer (JE)", phone: "9113048826" },
      { name: "Shruthi H", nameKn: "ಶ್ರುತಿ ಎಚ್", designation: "Asst-Exe Engineer (AEE)", phone: "9113270974" },
      { name: "Abishek KR", nameKn: "ಅಭಿಷೇಕ್ ಕೆಆರ್", designation: "Exe-Engineer (EE)", phone: "7892198334" },
      { name: "Dandeppa", nameKn: "ದಂಡೇಪ್ಪ", designation: "UGD Maintenance", phone: "9611250996" },
      { name: "Manjunath", nameKn: "ಮಂಜುನಾಥ್", designation: "UGD Maintenance", phone: "9945745133" },
    ],
  },
  {
    id: "electrical",
    name: "Electrical Department",
    scope: "Street lights, Park lights, Tree obstruction",
    helpline: "8277234444",
    email: "commissioner_davanagere@yahoo.com",
    office: "City Corporation, Davanagere",
    officials: [
      { name: "Shoheb", nameKn: "ಶೋಹೇಬ್", designation: "Electrical Engineer", phone: "8660852374" },
    ],
  },
  {
    id: "revenue",
    name: "Revenue Services",
    scope: "Property tax, Revenue collection, Land records",
    helpline: "8277234444",
    email: "commissioner_davanagere@yahoo.com",
    office: "City Corporation, Davanagere",
    officials: [
      { name: "Umesh M", nameKn: "ಉಮೇಶ್ ಎಂ", designation: "Revenue Inspector", phone: "9740292929" },
      { name: "Yamunesh M", nameKn: "ಯಮುನೇಶ್ ಎಂ", designation: "Property Tax Bill collector", phone: "9611915076" },
    ],
  },
  {
    id: "animal",
    name: "Animal Husbandry",
    scope: "Stray dogs, Stray cattle, Stray pigs, Dead animals, Snakes",
    helpline: "8277234444",
    email: "commissioner_davanagere@yahoo.com",
    office: "City Corporation, Davanagere",
    officials: [
      { name: "Jagadeesh S R", nameKn: "ಜಗದೀಶ್ ಎಸ್ ಆರ್", designation: "Asst-Exe Engineer (AEE) Environment", phone: "9632983527" },
    ],
  },
  {
    id: "corporation",
    name: "Davanagere City Corporation",
    scope: "Municipal governance, civic services, urban planning and city administration",
    helpline: "8050061112",
    email: "ka.davanagere.cc@gmail.com",
    office: "City Corporation, Davanagere",
    officials: [
      { name: "Dr. N.Mahantesh", nameKn: "ಡಾ. ಎನ್.ಮಹಂತೇಶ್", designation: "Commissioner", phone: "8050061112" },
    ],
  },
  {
    id: "ward",
    name: "Ward Corporator",
    scope: "Davanagere Municipal Corporation",
    helpline: "—",
    email: "—",
    office: "—",
    officials: [
      { name: "To be elected", nameKn: "ಚುನಾಯಿತರಾಗಬೇಕು", designation: "Corporator", phone: "—" },
    ],
  },
  {
    id: "mla",
    name: "MLA Information",
    scope: "Member of Legislative Assembly",
    helpline: "080-22255023",
    email: "—",
    office: "Home Office",
    officials: [
      { name: "Samarth Mallikarjun", nameKn: "ಸಮರ್ಥ ಮಲ್ಲಿಕಾರ್ಜುನ್", designation: "MLA", phone: "080-22255023" },
    ],
  },
  {
    id: "mp",
    name: "MP Information",
    scope: "Member of Parliament",
    helpline: "9964070830",
    email: "prabhamallikarjun76@gmail.com",
    office: "Home Office",
    officials: [
      { name: "Dr. Prabha Mallikarjun", nameKn: "ಡಾ. ಪ್ರಭಾ ಮಲ್ಲಿಕಾರ್ಜುನ್", designation: "MP", phone: "9964070830" },
    ],
  },
];

/**
 * Grievance tab — mirrors the Samarth Shamanur campaign grievance page.
 * The page itself is a bridge/entry point: it presents the Kannada + English
 * "raise your concern" copy and a primary CTA that opens NammaDVG.com (the
 * actual grievance platform).
 */
export function GrievanceView() {
  const { lang } = useLanguage();

  return (
    <div className="grievance-page" data-testid="grievance-page">
      <div className="grievance-page__inner">
        <div className="grievance-hero">
          <span className="grievance-hero__emoji" aria-hidden="true">🤝</span>
          <h1 className="grievance-hero__kn">ನಿಮ್ಮ ಸಮಸ್ಯೆ ಏನು?</h1>
          <p className="grievance-hero__kn-sub">ನಾವು ಕೇಳಲು ಇದ್ದೇವೆ.</p>

          <h2 className="grievance-hero__en">Have a concern? We are here to listen.</h2>
          <p className="grievance-hero__en-sub">
            ನಿಮ್ಮ ಧ್ವನಿ ಮುಖ್ಯ. ನಿಮ್ಮ ದೂರುಗಳನ್ನು ಹಂಚಿಕೊಳ್ಳಿ.
            <br />
            Your voice matters. Raise your grievance and be heard.
          </p>

          <a
            className="grievance-cta"
            href={NAMMADVG_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="grievance-raise"
          >
            {lang === "kn" ? "ದೂರು ಸಲ್ಲಿಸಿ" : "Raise Your Grievance"}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
              <path d="M7 17 17 7M17 7H8M17 7v9" />
            </svg>
          </a>

          <p className="grievance-trust">ಕೆಲಸ ಕಂಡಿದ್ದೇವೆ… ನಂಬಿಕೆ ಇದೆ…<br />Seen the work. Trust the system.</p>
        </div>

        {/* ── CONNECT OFFICIALS DIRECTORY ─────────────────────────── */}
        <section className="ds-officials ds-officials--grievance">
          <div className="ds-officials__header">
            <div className="ds-officials__title-wrap">
              <h2 className="ds-officials__title">{lang === "kn" ? "ಅಧಿಕಾರಿಗಳನ್ನು ಸಂಪರ್ಕಿಸಿ" : "Connect Officials"}</h2>
              <p className="ds-officials__sub">{lang === "kn" ? "ನಿಮ್ಮ ಸಮಸ್ಯೆಗೆ ಸರಿಯಾದ ಇಲಾಖೆಯನ್ನು ಆಯ್ಕೆಮಾಡಿ" : "Find the right department and contact for your concern"}</p>
            </div>
          </div>

          <div className="ds-officials__grid">
            {CITY_OFFICIALS.map((dept) => (
              <div className="ds-officials__card" key={dept.id}>
                <div className="ds-officials__panel-head">
                  <h3 className="ds-officials__panel-title">{dept.name}</h3>
                  <p className="ds-officials__scope">{dept.scope}</p>
                </div>
                <ul className="ds-officials__list">
                  {dept.officials.map((o, i) => (
                    <li className="ds-official" key={`${o.name}-${i}`}>
                      <div className="ds-official__main">
                        <span className="ds-official__name">{lang === "kn" ? o.nameKn : o.name}</span>
                        <span className="ds-official__desg">{o.designation}</span>
                      </div>
                      {o.phone && o.phone !== "—" && (
                        <a className="ds-official__phone" href={`tel:${o.phone}`}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" aria-hidden="true">
                            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {o.phone}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="ds-officials__meta">
                  <div><span>Office</span>{dept.office}</div>
                  <div><span>Helpline</span>{dept.helpline}</div>
                  <div><span>Email</span>{dept.email}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
