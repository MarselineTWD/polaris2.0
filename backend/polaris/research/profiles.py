"""Встроенные демонстрационные профили оборудования.

Числа не являются паспортами конкретного аппарата.  Они образуют три явно
помеченных уровня энергетики, чтобы исследовать чувствительность проекта к
оборудованию, когда у синтетических S01…S48 нет реальных радиопараметров.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any


_PROFILES: tuple[dict[str, Any], ...] = (
    {
        "id": "conservative",
        "label": "Слабый",
        "tone": "warning",
        "description": "Малые антенны и ограниченная энергетика; нижняя граница оценки.",
        "assumption": True,
        "satellite": {"mass_kg": 260.0, "area_m2": 3.8, "cd": 2.2, "cr": 1.3},
        "client": {
            "uplink": {"frequency_ghz": 14.0, "eirp_dbw": 43.0, "g_over_t_db_k": 0.0,
                       "bitrate_mbps": 100.0, "required_ebn0_db": 8.0, "pointing_loss_db": 1.4},
            "downlink": {"frequency_ghz": 12.0, "eirp_dbw": 27.0, "g_over_t_db_k": 13.0,
                         "bitrate_mbps": 100.0, "required_ebn0_db": 8.0, "pointing_loss_db": 1.2},
            "terminals": 2,
        },
        "gateway": {
            "uplink": {"frequency_ghz": 30.0, "eirp_dbw": 58.0, "g_over_t_db_k": 4.0,
                       "bitrate_mbps": 300.0, "required_ebn0_db": 9.0, "pointing_loss_db": 1.3},
            "downlink": {"frequency_ghz": 20.0, "eirp_dbw": 36.0, "g_over_t_db_k": 23.0,
                         "bitrate_mbps": 300.0, "required_ebn0_db": 9.0, "pointing_loss_db": 1.1},
            "terminals": 3,
        },
        "rf_isl": {"frequency_ghz": 26.0, "eirp_dbw": 36.0, "g_over_t_db_k": 7.0,
                   "bitrate_mbps": 30.0, "required_ebn0_db": 7.0, "pointing_loss_db": 1.5,
                   "terminals": 3},
        "optical_isl": {"wavelength_nm": 1550.0, "tx_power_dbw": 3.0,
                        "tx_gain_dbi": 108.0, "rx_gain_dbi": 108.0,
                        "required_rx_dbw": -45.0, "pointing_loss_db": 4.0, "terminals": 2},
    },
    {
        "id": "nominal",
        "label": "Номинальный",
        "tone": "accent",
        "description": "Рабочая демонстрационная конфигурация для сравнительного анализа.",
        "assumption": True,
        "satellite": {"mass_kg": 260.0, "area_m2": 3.2, "cd": 2.2, "cr": 1.3},
        "client": {
            "uplink": {"frequency_ghz": 14.0, "eirp_dbw": 48.0, "g_over_t_db_k": 4.0,
                       "bitrate_mbps": 100.0, "required_ebn0_db": 7.0, "pointing_loss_db": 0.9},
            "downlink": {"frequency_ghz": 12.0, "eirp_dbw": 34.0, "g_over_t_db_k": 17.0,
                         "bitrate_mbps": 100.0, "required_ebn0_db": 7.0, "pointing_loss_db": 0.8},
            "terminals": 3,
        },
        "gateway": {
            "uplink": {"frequency_ghz": 30.0, "eirp_dbw": 64.0, "g_over_t_db_k": 8.0,
                       "bitrate_mbps": 300.0, "required_ebn0_db": 8.0, "pointing_loss_db": 0.8},
            "downlink": {"frequency_ghz": 20.0, "eirp_dbw": 42.0, "g_over_t_db_k": 28.0,
                         "bitrate_mbps": 300.0, "required_ebn0_db": 8.0, "pointing_loss_db": 0.7},
            "terminals": 4,
        },
        "rf_isl": {"frequency_ghz": 26.0, "eirp_dbw": 43.0, "g_over_t_db_k": 11.0,
                   "bitrate_mbps": 30.0, "required_ebn0_db": 6.0, "pointing_loss_db": 0.8,
                   "terminals": 4},
        "optical_isl": {"wavelength_nm": 1550.0, "tx_power_dbw": 5.0,
                        "tx_gain_dbi": 111.0, "rx_gain_dbi": 111.0,
                        "required_rx_dbw": -47.0, "pointing_loss_db": 2.5, "terminals": 4},
    },
    {
        "id": "enhanced",
        "label": "Усиленный",
        "tone": "good",
        "description": "Крупные антенны, точное наведение и повышенная энергетика.",
        "assumption": True,
        "satellite": {"mass_kg": 320.0, "area_m2": 3.2, "cd": 2.1, "cr": 1.25},
        "client": {
            "uplink": {"frequency_ghz": 14.0, "eirp_dbw": 53.0, "g_over_t_db_k": 8.0,
                       "bitrate_mbps": 100.0, "required_ebn0_db": 6.0, "pointing_loss_db": 0.5},
            "downlink": {"frequency_ghz": 12.0, "eirp_dbw": 40.0, "g_over_t_db_k": 21.0,
                         "bitrate_mbps": 100.0, "required_ebn0_db": 6.0, "pointing_loss_db": 0.4},
            "terminals": 4,
        },
        "gateway": {
            "uplink": {"frequency_ghz": 30.0, "eirp_dbw": 70.0, "g_over_t_db_k": 12.0,
                       "bitrate_mbps": 300.0, "required_ebn0_db": 7.0, "pointing_loss_db": 0.4},
            "downlink": {"frequency_ghz": 20.0, "eirp_dbw": 48.0, "g_over_t_db_k": 32.0,
                         "bitrate_mbps": 300.0, "required_ebn0_db": 7.0, "pointing_loss_db": 0.4},
            "terminals": 6,
        },
        "rf_isl": {"frequency_ghz": 26.0, "eirp_dbw": 49.0, "g_over_t_db_k": 15.0,
                   "bitrate_mbps": 30.0, "required_ebn0_db": 5.0, "pointing_loss_db": 0.4,
                   "terminals": 6},
        "optical_isl": {"wavelength_nm": 1550.0, "tx_power_dbw": 7.0,
                        "tx_gain_dbi": 114.0, "rx_gain_dbi": 114.0,
                        "required_rx_dbw": -49.0, "pointing_loss_db": 1.4, "terminals": 6},
    },
)


def profile_catalog() -> list[dict[str, Any]]:
    """Вернуть копию каталога, безопасную для сериализации и UI."""
    return deepcopy(list(_PROFILES))


def get_profile(profile_id: str) -> dict[str, Any]:
    for profile in _PROFILES:
        if profile["id"] == profile_id:
            return deepcopy(profile)
    raise KeyError(profile_id)
