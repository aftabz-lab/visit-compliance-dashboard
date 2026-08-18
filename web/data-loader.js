/*
 * Visit Compliance Dashboard
 * Last-successful-data fallback loader
 *
 * Current data available  -> use current data and save it.
 * Current data unavailable -> use the last successfully fetched data.
 *
 * This file is specific to the Visit Compliance Dashboard.
 */

const DATA_URL = "./data/dashboard_data.json";

const LAST_DATA_KEY =
    "visit_compliance_last_successful_data";

const LAST_FETCH_KEY =
    "visit_compliance_last_successful_fetch";


export async function loadDashboardData() {

    try {

        const response = await fetch(
            `${DATA_URL}?_=${Date.now()}`,
            {
                cache: "no-store"
            }
        );

        if (!response.ok) {
            throw new Error(
                `Raw data unavailable: HTTP ${response.status}`
            );
        }

        const data = await response.json();

        if (
            data === null ||
            data === undefined ||
            (
                typeof data === "object" &&
                Object.keys(data).length === 0
            )
        ) {
            throw new Error("Raw data is empty.");
        }

        localStorage.setItem(
            LAST_DATA_KEY,
            JSON.stringify(data)
        );

        localStorage.setItem(
            LAST_FETCH_KEY,
            new Date().toISOString()
        );

        return {
            data,
            usingLastData: false,
            lastFetched: new Date().toISOString()
        };

    } catch (error) {

        console.warn(
            "Current raw data unavailable. Using last successfully fetched data.",
            error
        );

        const lastData =
            localStorage.getItem(LAST_DATA_KEY);

        const lastFetch =
            localStorage.getItem(LAST_FETCH_KEY);

        if (!lastData) {
            throw new Error(
                "No current raw data is available and no previously fetched data exists."
            );
        }

        return {
            data: JSON.parse(lastData),
            usingLastData: true,
            lastFetched: lastFetch
        };
    }
}


export function getDataStatus(result) {

    if (!result.usingLastData) {
        return {
            type: "current",
            text: "Showing latest data."
        };
    }

    const date =
        result.lastFetched
            ? new Date(result.lastFetched)
            : null;

    const formattedDate =
        date && !Number.isNaN(date.getTime())
            ? date.toLocaleString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            })
            : "previous successful update";

    return {
        type: "previous",
        text:
            `Raw data is currently unavailable. Showing the last successfully fetched data (${formattedDate}).`
    };
}


export function clearCachedDashboardData() {

    localStorage.removeItem(
        LAST_DATA_KEY
    );

    localStorage.removeItem(
        LAST_FETCH_KEY
    );
}
