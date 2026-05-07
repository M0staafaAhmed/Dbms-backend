require('dotenv').config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ==========================================
// 1. DATABASE CONNECTIONS
// ==========================================
const dbConfig = {
    host: "safe-space-saffe-space.j.aivencloud.com",
    port: 10399,
    user: "avnadmin",
    password: process.env.DB_PASSWORD,
    database: "defaultdb",
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const centralDB = mysql.createPool({ ...dbConfig, database: "hospital_distributed_system" });
const cairoDB = mysql.createPool({ ...dbConfig, database: "hospital_cairo" });
const alexDB = mysql.createPool({ ...dbConfig, database: "hospital_alex" });

const getDB = (branch) => {
    if (branch === "cairo") return cairoDB;
    if (branch === "alex") return alexDB;
    return null;
};

// ==========================================
// 2. CENTRAL ROUTES (العرض الكلي من السنترال)
// ==========================================

app.get("/patients", async (req, res) => {
    try { const [rows] = await centralDB.query("SELECT * FROM patient WHERE isDeleted = 0"); res.json(rows); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/doctors", async (req, res) => {
    try { const [rows] = await centralDB.query("SELECT * FROM doctor WHERE isDeleted = 0"); res.json(rows); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/records", async (req, res) => {
    try {
        const query = `
            SELECT 
                mr.recordUUID, mr.diagnosis, mr.prescription, mr.visitDate, mr.branchID,
                p.patientUUID, p.name AS patientName, p.gender, p.birthDate, p.phoneNumber,
                d.doctorUUID, d.fullName AS doctorName, d.specialization
            FROM medicalrecord mr
            LEFT JOIN patient p ON mr.patientUUID = p.patientUUID
            LEFT JOIN doctor d ON mr.doctorID = d.doctorUUID
        `;
        // ملحوظة: شلنا mr.isDeleted من الـ WHERE لأنك بتمسح نهائي من السنترال

        const [rows] = await centralDB.query(query);

        // تحويل الداتا لـ Nested Objects
        const formattedRows = rows.map(row => ({
            recordUUID: row.recordUUID,
            diagnosis: row.diagnosis,
            prescription: row.prescription,
            visitDate: row.visitDate,
            branchID: row.branchID,
            patient: {
                uuid: row.patientUUID,
                name: row.patientName,
                gender: row.gender,
                birthDate: row.birthDate,
                phoneNumber: row.phoneNumber
            },
            doctor: {
                uuid: row.doctorUUID,
                name: row.doctorName,
                specialization: row.specialization
            }
        }));

        res.json(formattedRows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. BRANCH GET & POST ROUTES
// ==========================================

// --- Doctors ---
app.get("/:branch/doctors", async (req, res) => {
    try {
        const db = getDB(req.params.branch);
        if (!db) return res.status(400).json({ error: "Invalid branch" });
        const [rows] = await db.query("SELECT * FROM doctor WHERE isDeleted = 0");
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/:branch/doctors", async (req, res) => {
    try {
        const branchName = req.params.branch;
        const db = getDB(branchName);
        if (!db) return res.status(400).json({ error: "Invalid branch" });

        const { doctorUUID, fullName, specialization } = req.body;
        const branchID = (branchName === "cairo") ? 1 : 2;

        await db.query(
            `INSERT INTO doctor (doctorUUID, fullName, specialization, branchID, isSynced, isDeleted) 
            VALUES (?, ?, ?, ?, 0, 0)`,
            [doctorUUID, fullName, specialization, branchID]
        );
        res.json({ message: `Doctor added locally to ${branchName}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Patients ---
app.get("/:branch/patients", async (req, res) => {
    try {
        const db = getDB(req.params.branch);
        if (!db) return res.status(400).json({ error: "Invalid branch" });
        const [rows] = await db.query("SELECT * FROM patient WHERE isDeleted = 0");
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/:branch/patients", async (req, res) => {
    try {
        const db = getDB(req.params.branch);
        if (!db) return res.status(400).json({ error: "Invalid branch" });

        const { patientUUID, name, gender, birthDate, phoneNumber, originBranchID } = req.body;
        const [existing] = await db.query("SELECT patientUUID FROM patient WHERE phoneNumber = ?", [phoneNumber]);
        if (existing.length > 0) return res.status(400).json({ error: "Phone number exists" });

        await db.query(
            `INSERT INTO patient (patientUUID, name, gender, birthDate, phoneNumber, originBranchID, isSynced, isDeleted) 
            VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
            [patientUUID, name, gender, birthDate, phoneNumber, originBranchID]
        );
        res.json({ message: "Patient added locally" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Medical Records ---
app.get("/:branch/records", async (req, res) => {
    try {
        const db = getDB(req.params.branch);
        if (!db) return res.status(400).json({ error: "Invalid branch" });

        const query = `
            SELECT 
                mr.recordUUID, mr.diagnosis, mr.prescription, mr.visitDate, mr.branchID, mr.isSynced,
                p.patientUUID, p.name AS patientName, p.gender, p.birthDate, p.phoneNumber,
                d.doctorUUID, d.fullName AS doctorName, d.specialization
            FROM medicalrecord mr
            LEFT JOIN patient p ON mr.patientUUID = p.patientUUID
            LEFT JOIN doctor d ON mr.doctorID = d.doctorUUID
            WHERE mr.isDeleted = 0
        `;

        const [rows] = await db.query(query);

        // تحويل النتائج لتنسيق Nested Objects
        const formattedRows = rows.map(row => ({
            recordUUID: row.recordUUID,
            diagnosis: row.diagnosis,
            prescription: row.prescription,
            visitDate: row.visitDate,
            branchID: row.branchID,
            isSynced: row.isSynced,
            patient: {
                uuid: row.patientUUID,
                name: row.patientName,
                gender: row.gender,
                birthDate: row.birthDate,
                phoneNumber: row.phoneNumber
            },
            doctor: {
                uuid: row.doctorUUID,
                name: row.doctorName,
                specialization: row.specialization
            }
        }));

        res.json(formattedRows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/:branch/records", async (req, res) => {
    try {
        const branchName = req.params.branch;
        const db = getDB(branchName);
        if (!db) return res.status(400).json({ error: "Invalid branch" });

        const { recordUUID, patientUUID, doctorID, diagnosis, prescription, visitDate } = req.body;
        const branchID = (branchName === "cairo") ? 1 : 2;

        // --- تحويل التاريخ لتنسيق MySQL ---
        // السطر ده بياخد '2026-05-02T18:24:09.415Z' 
        // وبيحولها لـ '2026-05-02 18:24:09'
        const formattedDate = visitDate ? new Date(visitDate).toISOString().slice(0, 19).replace('T', ' ') : new Date();

        await db.query(
            `INSERT INTO medicalrecord (recordUUID, patientUUID, doctorID, diagnosis, prescription, visitDate, branchID, isSynced, isDeleted) 
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
            [recordUUID, patientUUID, doctorID, diagnosis, prescription, formattedDate, branchID]
        );

        res.json({ message: "Success" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 4. BRANCH DELETE ROUTES (Soft Delete)
// ==========================================
app.delete("/:branch/:type/:uuid", async (req, res) => {
    try {
        const db = getDB(req.params.branch);
        const { type, uuid } = req.params;
        if (!db) return res.status(400).json({ error: "Invalid branch" });

        let table = "";
        let idCol = "";

        if (type === "doctors") { table = "doctor"; idCol = "doctorUUID"; }
        else if (type === "patients") { table = "patient"; idCol = "patientUUID"; }
        else if (type === "records") { table = "medicalrecord"; idCol = "recordUUID"; }
        else return res.status(400).json({ error: "Invalid type" });

        await db.query(`UPDATE ${table} SET isDeleted = 1, isSynced = 0 WHERE ${idCol} = ?`, [uuid]);
        res.json({ message: `${type} marked for deletion` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 5. MASTER SYNC ENGINE
// ==========================================
async function syncBranch(branchDB, nodeID) {
    let conn;
    try {
        conn = await branchDB.getConnection();

        // 1. تنفيذ عمليات الحذف (DELETE)
        const [delRecs] = await conn.query("SELECT recordUUID FROM medicalrecord WHERE isDeleted = 1");
        const [delPats] = await conn.query("SELECT patientUUID FROM patient WHERE isDeleted = 1");
        const [delDocs] = await conn.query("SELECT doctorUUID FROM doctor WHERE isDeleted = 1");

        for (const r of delRecs) {
            await centralDB.query("DELETE FROM medicalrecord WHERE recordUUID = ?", [r.recordUUID]);
            await conn.query("DELETE FROM medicalrecord WHERE recordUUID = ?", [r.recordUUID]);
        }
        for (const p of delPats) {
            await centralDB.query("DELETE FROM patient WHERE patientUUID = ?", [p.patientUUID]);
            await conn.query("DELETE FROM patient WHERE patientUUID = ?", [p.patientUUID]);
        }
        for (const d of delDocs) {
            await centralDB.query("DELETE FROM doctor WHERE doctorUUID = ?", [d.doctorUUID]);
            await conn.query("DELETE FROM doctor WHERE doctorUUID = ?", [d.doctorUUID]);
        }

        // 2. مزامنة البيانات الجديدة
        const [docs] = await conn.query("SELECT * FROM doctor WHERE isSynced = 0 AND isDeleted = 0");
        const [pats] = await conn.query("SELECT * FROM patient WHERE isSynced = 0 AND isDeleted = 0");
        const [recs] = await conn.query("SELECT * FROM medicalrecord WHERE isSynced = 0 AND isDeleted = 0");

        if (docs.length > 0 || pats.length > 0 || recs.length > 0) {
            await conn.beginTransaction();

            for (const d of docs) {
                await centralDB.query(
                    `INSERT INTO doctor (doctorUUID, fullName, specialization, branchID, isDeleted) 
                     VALUES (?, ?, ?, ?, 0) ON DUPLICATE KEY UPDATE fullName=VALUES(fullName)`,
                    [d.doctorUUID, d.fullName, d.specialization, nodeID]
                );
                await conn.query("UPDATE doctor SET isSynced = 1 WHERE doctorUUID = ?", [d.doctorUUID]);
            }

            for (const p of pats) {
                await centralDB.query(
                    `INSERT INTO patient (patientUUID, name, gender, birthDate, phoneNumber, originBranchID, isDeleted) 
                     VALUES (?, ?, ?, ?, ?, ?, 0) ON DUPLICATE KEY UPDATE name=VALUES(name)`,
                    [p.patientUUID, p.name, p.gender, p.birthDate, p.phoneNumber, p.originBranchID]
                );
                await conn.query("UPDATE patient SET isSynced = 1 WHERE patientUUID = ?", [p.patientUUID]);
            }

            for (const r of recs) {
                await centralDB.query(
                    `INSERT INTO medicalrecord (recordUUID, patientUUID, doctorID, diagnosis, prescription, visitDate, branchID, isDeleted) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON DUPLICATE KEY UPDATE diagnosis=VALUES(diagnosis)`,
                    [r.recordUUID, r.patientUUID, r.doctorID, r.diagnosis, r.prescription, r.visitDate, nodeID]
                );
                await conn.query("UPDATE medicalrecord SET isSynced = 1 WHERE recordUUID = ?", [r.recordUUID]);
            }

            await conn.commit();
            console.log(`[SYNC SUCCESS] Node ${nodeID} updated.`);
        }
    } catch (err) {
        if (conn) await conn.rollback();
        console.error(`[SYNC ERROR] Node ${nodeID}: ${err.message}`);
    } finally {
        if (conn) conn.release();
    }
}

app.get("/api/sync", async (req, res) => {
    // تأمين الـ Route: بنشيك على الـ Secret Key في الـ Headers أو الـ Query
    const secret = req.query.secret;
    
    if (secret !== process.env.CRON_SECRET) {
        console.error("⚠️ Unauthorized sync attempt!");
        return res.status(401).json({ error: "Unauthorized: Invalid Secret Key" });
    }

    console.log("🔄 Manual Sync Triggered via API...");

    try {
        // تشغيل المزامنة للفروع بشكل تتابعي (Sequential) عشان نتجنب الـ Timeout
        console.log("Starting Cairo Node Sync...");
        await syncBranch(cairoDB, 1);
        
        console.log("Starting Alex Node Sync...");
        await syncBranch(alexDB, 2);

        res.status(200).json({ 
            message: "Synchronization completed successfully",
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error("❌ Sync API Error:", err.message);
        res.status(500).json({ error: "Sync failed", details: err.message });
    }
});

app.listen(5000, () => console.log("🚀 SYSTEM ONLINE ON PORT 5000"));