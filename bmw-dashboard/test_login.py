#!/usr/bin/env python3
"""Direkter bimmer_connected Test – ohne Flask-Server"""

import asyncio
import sys

EMAIL    = input("BMW E-Mail: ")
PASSWORD = input("BMW Passwort: ")
TOKEN    = input("hCaptcha Token (von http://localhost:3001 Captcha-Widget): ")

async def main():
    from bimmer_connected.account import MyBMWAccount
    from bimmer_connected.api.regions import get_region_from_name
    import httpx

    print("\n[1] Verbinde mit BMW API...")
    try:
        account = MyBMWAccount(
            EMAIL, PASSWORD,
            get_region_from_name("rest_of_world"),
            hcaptcha_token=TOKEN
        )
        await account.get_vehicles()
        print(f"[OK] {len(account.vehicles)} Fahrzeug(e) gefunden:")
        for v in account.vehicles:
            print(f"     {v.vin}  {v.name}")
    except Exception as e:
        print(f"\n[FEHLER] {type(e).__name__}: {e}")
        if hasattr(e, 'response'):
            try:
                print(f"  HTTP {e.response.status_code}: {e.response.text[:300]}")
            except Exception:
                pass
        raise

asyncio.run(main())
